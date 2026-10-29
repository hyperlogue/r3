import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactApi } from "./artifact-api.ts";
import { type ArtifactStorage, openArtifactStorage } from "./artifact-storage.ts";

let root: string;
let storage: ArtifactStorage;
const first = "2026-10-01T00:00:00.000Z";
let time = first;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-onboarding-"));
  time = first;
  storage = await openArtifactStorage({
    databasePath: join(root, "store.sqlite"),
    clock: () => time,
  });
});
afterEach(async () => {
  storage.close();
  await rm(root, { recursive: true, force: true });
});
test("installation progress survives restart and stale skips cannot downgrade completion", async () => {
  expect(storage.onboarding.read()).toEqual({ status: "new", updatedAt: null });
  expect(storage.onboarding.update({ status: "skipped" })).toEqual({
    status: "skipped",
    updatedAt: first,
  });
  storage.close();
  storage = await openArtifactStorage({
    databasePath: join(root, "store.sqlite"),
    clock: () => time,
  });
  expect(storage.onboarding.read().status).toBe("skipped");
  time = "2026-10-02T00:00:00.000Z";
  const completed = storage.onboarding.update({ status: "completed" });
  expect(completed).toEqual({ status: "completed", updatedAt: time });
  time = "2026-10-03T00:00:00.000Z";
  expect(storage.onboarding.update({ status: "skipped" })).toEqual(completed);
  expect(storage.onboarding.update({ status: "completed" })).toEqual(completed);
  expect(() => storage.onboarding.update({ status: "new" })).toThrow();
});
test("schema 18 upgrades with a backup and preserves published data", async () => {
  const artifact = storage.artifacts.create({
    kind: "files",
    actor: { role: "human", sessionId: null },
    title: "Retained artifact",
  });
  const actor = { role: "human" as const, sessionId: null };
  await storage.artifacts.publish(artifact.id, {
    actor,
    expectedSeq: 0,
    publicationKey: "preserved",
    content: {
      kind: "files",
      files: [
        {
          path: "source.ts",
          mediaType: "text/plain",
          base64: Buffer.from("const saved = true;\n").toString("base64"),
        },
      ],
    },
  });
  const thread = await storage.conversations.add(artifact.id, {
    actor,
    body: "Keep this discussion",
    target: { kind: "artifact" },
  });
  const version = storage.artifacts.versions(artifact.id);
  storage.close();
  const old = new Database(join(root, "store.sqlite"));
  old.exec("DROP TABLE onboarding; PRAGMA user_version = 18");
  old.close();
  storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
  expect(storage.migration?.migrated).toBe(true);
  expect(storage.artifacts.get(artifact.id).title).toBe("Retained artifact");
  expect(storage.artifacts.versions(artifact.id)).toEqual(version);
  expect(storage.conversations.get(thread.id)).toEqual(thread);
  expect(storage.onboarding.read()).toEqual({ status: "new", updatedAt: null });
  const backup = new Database(storage.migration!.backupPath!, { readonly: true });
  expect(backup.query("PRAGMA user_version").get()).toEqual({ user_version: 18 });
  expect(backup.query("SELECT name FROM sqlite_master WHERE name = 'onboarding'").get()).toBeNull();
  backup.close();
});
test("onboarding API authenticates reads and writes, guards origins, and validates status", async () => {
  const api = createArtifactApi(storage, {
    token: "test-token",
    version: "test",
    requireLogin: true,
    allowedHost: (host) => host === "localhost",
  });
  const request = (method: string, body?: unknown, headers: Record<string, string> = {}) =>
    api.app.request(
      new Request("http://localhost/api/onboarding", {
        method,
        headers: { host: "localhost", "content-type": "application/json", ...headers },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
  try {
    const auth = { "x-r3-token": "test-token" };
    expect((await request("GET")).status).toBe(401);
    expect((await request("PUT", { status: "completed" })).status).toBe(401);
    expect(
      (
        await request(
          "PUT",
          { status: "completed" },
          { ...auth, origin: "https://untrusted.invalid" },
        )
      ).status,
    ).toBe(403);
    const read = await request("GET", undefined, auth);
    expect(read.headers.get("cache-control")).toBe("no-store");
    expect(await read.json()).toEqual({ status: "new", updatedAt: null });
    for (const body of [null, [], {}, { status: "new" }, { status: 1 }])
      expect((await request("PUT", body, auth)).status).toBe(400);
    expect(storage.onboarding.read().status).toBe("new");
    const saved = await request("PUT", { status: "completed" }, auth);
    expect(saved.status).toBe(200);
    expect(saved.headers.get("cache-control")).toBe("no-store");
    expect((await saved.json()).status).toBe("completed");
  } finally {
    api.close();
  }
});
