import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactClient } from "../shared/artifact-client.ts";
import { createArtifactApi } from "./artifact-api.ts";
import { type ArtifactStorage, openArtifactStorage } from "./artifact-storage.ts";
import { localAgentApi, startLocalAgents } from "./local-agents.ts";

let root: string;
let storage: ArtifactStorage;
let api: ReturnType<typeof createArtifactApi>;
let token: string;
const actor = { role: "agent", sessionId: "local-agent" } as const;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-local-agents-"));
  storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
  token = randomBytes(24).toString("hex");
  api = createArtifactApi(
    storage,
    { token, requireLogin: false, version: "test", allowedHost: (host) => host === "localhost" },
    { deliver: async () => "queued" },
  );
  storage.artifacts.registerSession({ id: actor.sessionId, label: "Helpful agent" });
});
afterEach(async () => {
  api.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
});

test("application HTTP cannot register harness targets; the local handler requires a credential and rejects browser origins", async () => {
  const body = JSON.stringify({ actor, target: { harness: "codex", threadId: "thread-local" } });
  const headers = { "content-type": "application/json", "x-r3-token": token, host: "localhost" };
  const publicResult = await api.app.request("http://localhost/api/local/target", {
    method: "POST",
    headers,
    body,
  });
  expect(publicResult.status).toBe(404);
  const local = localAgentApi(storage, api.collaboration, token);
  expect((await local.request("/api/local/target", { method: "POST", body })).status).toBe(403);
  expect(
    (
      await local.request("/api/local/target", {
        method: "POST",
        headers: { ...headers, origin: "http://localhost" },
        body,
      })
    ).status,
  ).toBe(403);
  expect((await local.request("/api/local/target", { method: "POST", headers, body })).status).toBe(
    200,
  );
  const id = storage.artifacts.create({ actor, kind: "files" }).id;
  const registration = await local.request("/api/local/listen", {
    method: "POST",
    headers,
    body: JSON.stringify({ actor, artifactId: id }),
  });
  expect(registration.status).toBe(200);
  expect(await registration.json()).toMatchObject({ mode: "explicit", label: "Helpful agent" });
  expect(JSON.stringify(api.collaboration.watchers(id))).not.toContain("thread-local");
  expect(JSON.stringify(storage.artifacts.sessions())).not.toContain("thread-local");
});

test("the existing daemon can accept registration over its private Unix socket", async () => {
  const socket = join(root, "agents.sock");
  const local = await startLocalAgents(socket, storage, api.collaboration, token);
  try {
    const client = new ArtifactClient({
      url: "http://localhost",
      token,
      fetch: (request) => fetch(request, { unix: socket }),
    });
    await client.json("POST", "/api/local/target", {
      actor,
      target: { harness: "codex", threadId: "thread-local" },
    });
    const id = storage.artifacts.create({ actor, kind: "files" }).id;
    expect(await client.json("POST", "/api/local/listen", { actor, artifactId: id })).toMatchObject(
      { actor, kind: "listen", mode: "explicit" },
    );
    expect(await api.collaboration.submit(id)).toEqual({ state: "queued" });
  } finally {
    await local.stop();
  }
});
