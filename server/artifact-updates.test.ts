import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ArtifactDelta, mergeArtifactUpdate } from "../shared/artifact-updates.ts";
import type { ArtifactDetail, ArtifactStreamEvent } from "../shared/artifacts.ts";
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
  request(`/api/artifacts/${id}/threads`, "POST", {
    actor,
    body,
    target: { kind: "artifact" },
  });

test("small edits transfer one thread and preserve the complete snapshot", async () => {
  for (let index = 0; index < 50; index++) await add(`Note ${index}: ${"evidence ".repeat(100)}`);
  const before = await detail();
  const selected = before.threads[0]!;
  await request(`/api/threads/${selected.id}`, "PATCH", { actor, body: "Small edit" });
  const update = await delta(before);
  expect(update.delta).toBe(true);
  expect(update.threads).toHaveLength(1);
  expect(update.threads[0]?.comments[0]?.body).toBe("Small edit");
  expect(JSON.stringify(update).length).toBeLessThan(JSON.stringify(before).length / 10);
  expect(mergeArtifactUpdate(before, update)).toEqual(await detail());
  const empty = await delta(mergeArtifactUpdate(before, update));
  expect(empty.threads).toEqual([]);
  expect("versions" in empty).toBe(false);
});

test("deletions and claim changes merge without resending other threads", async () => {
  const first = await add("Claim me"),
    second = await add("Delete me");
  let snapshot = await detail();
  await request("/api/sessions", "POST", { id: "codex:run", harness: "codex", label: "Helper" });
  await request("/api/claims", "POST", { sessionId: "codex:run", threadIds: [first.id] });
  let update = await delta(snapshot);
  expect(update.threads).toEqual([]);
  expect(update.claims).toHaveLength(1);
  snapshot = mergeArtifactUpdate(snapshot, update);
  expect(snapshot).toEqual(await detail());
  await request(`/api/threads/${second.id}`, "DELETE", { actor });
  update = await delta(snapshot);
  expect(update.removedThreadIds).toEqual([second.id]);
  snapshot = mergeArtifactUpdate(snapshot, update);
  expect(snapshot).toEqual(await detail());
  await request("/api/claims", "DELETE", { sessionId: "codex:run", threadIds: [first.id] });
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

test("session renames invalidate every referenced role and refresh unchanged content and subscription labels", async () => {
  const roles = [
    "creator",
    "publisher",
    "opening",
    "comment",
    "claim",
    "lifecycle",
    "fallback",
    "explicit",
  ];
  const agent = (sessionId: string) => ({ role: "agent", sessionId }) as const;
  for (const session of [...roles, "unrelated"])
    await request("/api/sessions", "POST", { id: session, label: `Original ${session}` });
  id = storage.artifacts.create({ kind: "files", actor: agent("creator") }).id;
  const other = storage.artifacts.create({ kind: "files", actor: agent("creator") }).id;
  await storage.artifacts.publish(id, {
    actor: agent("publisher"),
    expectedSeq: 0,
    publicationKey: "first",
    content: {
      kind: "files",
      files: [
        {
          path: "note.txt",
          mediaType: "text/plain",
          base64: Buffer.from("Review").toString("base64"),
        },
      ],
    },
  });
  const thread = await storage.conversations.add(id, {
    actor: agent("opening"),
    body: "Original note",
    target: { kind: "artifact" },
  });
  await storage.conversations.addComment(thread.id, {
    actor: agent("comment"),
    body: "Original reply",
    context: { versionSeq: null, representation: null },
  });
  for (const event of ["archived", "restored"])
    storage.lifecycle.transition(id, { actor: agent("lifecycle"), event, operationKey: event });
  storage.conversations.claim([thread.id], "claim");
  for (const mode of ["fallback", "explicit"] as const)
    api.collaboration.register(
      id,
      agent(mode),
      () => {},
      async () => "sent",
      { mode },
    );
  const events: ArtifactStreamEvent[] = [];
  const unsubscribe = api.collaboration.subscribe((event) => events.push(event));
  try {
    for (const session of roles) {
      const before = await detail();
      events.length = 0;
      await request("/api/sessions", "POST", { id: session, label: `Updated ${session}` });
      expect(events.map((event) => event.artifactId).sort()).toEqual(
        (session === "creator" ? [id, other] : [id]).sort(),
      );
      const update = await delta(before);
      expect("delta" in update).toBe(false);
      const merged = mergeArtifactUpdate(before, update);
      expect(merged).toEqual(await detail());
      if (session !== "explicit" && session !== "fallback")
        expect(merged.agentLabels?.[session]).toBe(`Updated ${session}`);
    }
    expect(api.collaboration.watchers(id)[0]?.label).toBe("Updated explicit");
    api.collaboration.unlisten(id, agent("explicit"));
    expect(api.collaboration.watchers(id)[0]?.label).toBe("Updated fallback");
    const before = await detail();
    await request("/api/sessions", "POST", { id: "creator", label: null });
    expect(mergeArtifactUpdate(before, await delta(before)).agentLabels?.creator).toBeNull();
    events.length = 0;
    await request("/api/sessions", "POST", { id: "creator", label: null });
    await request("/api/sessions", "POST", { id: "publisher" });
    await request("/api/sessions", "POST", { id: "unrelated", label: "Updated unrelated" });
    expect(events).toEqual([]);
  } finally {
    unsubscribe();
  }
});
