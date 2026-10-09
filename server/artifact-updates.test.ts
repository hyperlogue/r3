import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ArtifactDelta, mergeArtifactUpdate } from "../shared/artifact-updates.ts";
import type { ArtifactDetail } from "../shared/artifacts.ts";
import { artifactDetail, createArtifactApi } from "./artifact-api.ts";
import { type ArtifactStorage, openArtifactStorage } from "./artifact-storage.ts";
import { ArtifactUpdates } from "./artifact-updates.ts";

let root: string, storage: ArtifactStorage, api: ReturnType<typeof createArtifactApi>, id: string;
const actor = { role: "human", sessionId: null };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-incremental-"));
  storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
  api = createArtifactApi(storage, {
    token: "test",
    requireLogin: true,
    version: "test",
    allowedHost: (host) => host === "localhost",
  });
  id = storage.artifacts.create({ kind: "files", actor }).id;
});
afterEach(async () => {
  api.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
});
async function request(path: string, method = "GET", body?: unknown) {
  const response = await api.app.request(`http://localhost${path}`, {
    method,
    headers: { host: "localhost", "x-r3-token": "test", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  expect(response.status).toBeLessThan(400);
  return response.json();
}
const detail = () => request(`/api/artifacts/${id}`) as Promise<ArtifactDetail>;
const delta = (snapshot: ArtifactDetail) =>
  request(`/api/artifacts/${id}?since=${snapshot.syncCursor}`) as Promise<ArtifactDelta>;
const add = (body: string) =>
  request(`/api/artifacts/${id}/discussions`, "POST", {
    actor,
    body,
    target: { kind: "artifact" },
  });

test("small edits transfer one discussion and preserve the complete snapshot", async () => {
  for (let index = 0; index < 50; index++) await add(`Note ${index}: ${"evidence ".repeat(100)}`);
  const before = await detail();
  const selected = before.discussions[0]!;
  await request(`/api/discussions/${selected.id}`, "PATCH", { actor, body: "Small edit" });
  const update = await delta(before);
  expect(update.delta).toBe(true);
  expect(update.discussions).toHaveLength(1);
  expect(update.discussions[0]?.comments[0]?.body).toBe("Small edit");
  expect(JSON.stringify(update).length).toBeLessThan(JSON.stringify(before).length / 10);
  expect(mergeArtifactUpdate(before, update)).toEqual(await detail());
  const empty = await delta(mergeArtifactUpdate(before, update));
  expect(empty.discussions).toEqual([]);
  expect("versions" in empty).toBe(false);
});

test("deletions and claim changes merge without resending other discussions", async () => {
  const first = await add("Claim me"),
    second = await add("Delete me");
  let snapshot = await detail();
  await request("/api/sessions", "POST", { id: "codex:run", harness: "codex", label: "Helper" });
  await request("/api/claims", "POST", { sessionId: "codex:run", discussionIds: [first.id] });
  let update = await delta(snapshot);
  expect(update.discussions).toEqual([]);
  expect(update.claims).toHaveLength(1);
  snapshot = mergeArtifactUpdate(snapshot, update);
  expect(snapshot).toEqual(await detail());
  await request(`/api/discussions/${second.id}`, "DELETE", { actor });
  update = await delta(snapshot);
  expect(update.removedDiscussionIds).toEqual([second.id]);
  snapshot = mergeArtifactUpdate(snapshot, update);
  expect(snapshot).toEqual(await detail());
  await request("/api/claims", "DELETE", { sessionId: "codex:run", discussionIds: [first.id] });
  expect(mergeArtifactUpdate(snapshot, await delta(snapshot))).toEqual(await detail());
});

test("stale bases fail; gaps, restart, metadata and lifecycle recover with complete snapshots", async () => {
  await add("Review");
  const before = await detail();
  const journal = new ArtifactUpdates(
    storage,
    api.collaboration,
    (id) => artifactDetail(storage, id),
    2,
  );
  try {
    expect("delta" in journal.read(id, before.syncCursor)).toBe(false);
    const old = journal.snapshot(id);
    for (let index = 0; index < 3; index++)
      api.collaboration.broadcast({ type: "presence-changed", artifactId: id });
    expect("delta" in journal.read(id, old.syncCursor)).toBe(false);
    const update = await delta(before);
    expect(() => mergeArtifactUpdate({ ...before, syncCursor: "newer" }, update)).toThrow(
      "stale base",
    );
    await request(`/api/artifacts/${id}`, "PATCH", { title: "New title" });
    expect("delta" in (await delta(before))).toBe(false);
    const current = await detail();
    await request(`/api/artifacts/${id}/lifecycle`, "POST", {
      actor,
      event: "archived",
      operationKey: "archive",
    });
    expect("delta" in (await delta(current))).toBe(false);
  } finally {
    journal.close();
  }
});
