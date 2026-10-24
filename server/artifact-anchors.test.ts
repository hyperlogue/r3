import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactAnchorDestination } from "../shared/artifacts.ts";
import { createArtifactApi } from "./artifact-api.ts";
import { type ArtifactStorage, openArtifactStorage } from "./artifact-storage.ts";

const human = { role: "human", sessionId: null } as const;
const agent = { role: "agent", sessionId: "anchor-agent" } as const;
const image = {
  mediaType: "image/png",
  base64:
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4HyD3H4QZYAwAV6YJsVhH600AAAAASUVORK5CYII=",
} as const;
let root: string;
let store: ArtifactStorage;
let id: string;
const source = (
  versionSeq: number,
  line = 3,
): Extract<ArtifactAnchorDestination, { kind: "source" }> => ({
  kind: "source",
  versionSeq,
  path: "a.txt",
  locator: { start: line, end: line },
});
const publish = (expectedSeq: number, text = "prefix\nbefore\nkeep()\nfixed()\n") =>
  store.artifacts.publish(id, {
    actor: agent,
    expectedSeq,
    publicationKey: `version-${expectedSeq + 1}`,
    content: {
      kind: "files",
      files: [
        { path: "a.txt", mediaType: "text/plain", base64: Buffer.from(text).toString("base64") },
        { path: "image.png", ...image },
      ],
    },
  });
const note = () =>
  store.conversations.add(id, {
    actor: human,
    body: "Keep this evidence",
    target: {
      kind: "source",
      versionSeq: 1,
      path: "a.txt",
      locator: { start: 2, end: 2, quote: "keep()" },
    },
  });
const batch = (threadId: string, revision = 0, seq = 2, key = "move") => ({
  actor: agent,
  expectedSeq: seq,
  operationKey: key,
  items: [{ threadId, expectedAnchorRevision: revision, target: source(seq) }],
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-anchors-"));
  store = await openArtifactStorage({
    databasePath: join(root, "test.sqlite"),
    render: async (source) => ({ html: source, revision: "test" }),
  });
  store.artifacts.registerSession({ id: agent.sessionId });
  id = store.artifacts.create({ kind: "files", actor: human }).id;
  await publish(0, "before\nkeep()\nold()\n");
  await publish(1);
});
afterEach(async () => {
  store.close();
  await rm(root, { recursive: true, force: true });
});

test("moves preserve original evidence, messages, claim and pending content; stale snapshots conflict", async () => {
  const thread = await note();
  store.conversations.claim([thread.id], agent.sessionId);
  const before = store.conversations.get(thread.id);
  const snapshot = store.conversations.snapshot(id);
  const result = await store.conversations.anchors.reanchor(id, batch(thread.id));
  const after = store.conversations.get(thread.id);
  expect(result.results[0]).toEqual({ threadId: thread.id, revision: 1, changed: true });
  expect(after.target).toEqual(before.target);
  expect(after.comments).toEqual(before.comments);
  expect(after.claim).toEqual(before.claim);
  expect(after.status).toBe("open");
  expect(after.anchor?.target).toEqual({
    ...source(2),
    locator: { start: 3, end: 3, quote: "keep()" },
  });
  expect(() => store.conversations.acknowledge(id, snapshot.acknowledgment)).toThrow("changed");
  expect(
    (await store.conversations.anchors.reanchor(id, batch(thread.id, 1, 2, "noop"))).results[0]
      ?.changed,
  ).toBe(false);
});
test("invalid entries and stale per-thread revisions roll back the entire batch", async () => {
  const first = await note();
  const second = await note();
  const input = batch(first.id);
  input.items.push({ threadId: second.id, expectedAnchorRevision: 0, target: source(2, 99) });
  await expect(store.conversations.anchors.reanchor(id, input)).rejects.toThrow(second.id);
  expect(store.conversations.get(first.id).anchor).toBeNull();
  await store.conversations.anchors.reanchor(id, batch(second.id, 0, 2, "other"));
  input.items[1]!.target = source(2);
  await expect(store.conversations.anchors.reanchor(id, input)).rejects.toThrow("revision changed");
  expect(store.conversations.get(first.id).anchor).toBeNull();
});
test("quote replacement is rejected, and publication/archive races reject prepared moves", async () => {
  const thread = await note();
  const input = batch(thread.id);
  await expect(
    store.conversations.anchors.reanchor(id, {
      ...input,
      items: [
        {
          ...input.items[0],
          target: { ...source(2), locator: { start: 3, end: 3, quote: "replacement" } },
        },
      ],
    }),
  ).rejects.toThrow("immutable");
  const prepare = store.conversations.anchors.prepare.bind(store.conversations.anchors);
  store.conversations.anchors.prepare = async (...args) => {
    const target = await prepare(...args);
    await publish(2);
    return target;
  };
  await expect(store.conversations.anchors.reanchor(id, input)).rejects.toThrow(
    "publication changed",
  );
  expect(store.conversations.get(thread.id).anchor).toBeNull();
  store.conversations.anchors.prepare = async (...args) => {
    const target = await prepare(...args);
    store.lifecycle.transition(id, { event: "archived", actor: human, operationKey: "archive" });
    return target;
  };
  await expect(store.conversations.anchors.reanchor(id, batch(thread.id, 0, 3))).rejects.toThrow(
    "archived",
  );
  expect(store.conversations.get(thread.id).anchor).toBeNull();
});
test("targeted replies commit atomically and retries never restore an older anchor", async () => {
  const thread = await note();
  const input = {
    actor: agent,
    body: "Fixed",
    operationKey: "fix",
    target: { ...source(2, 4), locator: { start: 4, end: 4, quote: "fixed()" } },
    reanchor: { expectedSeq: 2, expectedAnchorRevision: 0 },
  };
  const comment = await store.conversations.addComment(thread.id, input);
  expect(store.conversations.get(thread.id).anchor?.revision).toBe(1);
  const count = store.conversations.get(thread.id).comments.length;
  await expect(
    store.conversations.addComment(thread.id, { ...input, operationKey: "stale" }),
  ).rejects.toThrow("revision changed");
  expect(store.conversations.get(thread.id).comments).toHaveLength(count);
  await publish(2);
  await store.conversations.anchors.reanchor(id, batch(thread.id, 1, 3, "newer"));
  expect((await store.conversations.addComment(thread.id, input)).id).toBe(comment.id);
  expect(store.conversations.get(thread.id).anchor?.target.versionSeq).toBe(3);
  expect(store.conversations.comment(comment.id).target?.versionSeq).toBe(2);
  await store.conversations.addComment(thread.id, {
    actor: agent,
    body: "Historical fix",
    target: input.target,
  });
  expect(store.conversations.get(thread.id).anchor?.target.versionSeq).toBe(3);
});
test("bulk receipts replay after later moves and archive, without rewriting current state", async () => {
  const thread = await note();
  const input = batch(thread.id);
  const result = await store.conversations.anchors.reanchor(id, input);
  await publish(2);
  await store.conversations.anchors.reanchor(id, batch(thread.id, 1, 3, "newer"));
  store.lifecycle.transition(id, { event: "archived", actor: human, operationKey: "archive" });
  expect(await store.conversations.anchors.reanchor(id, input)).toEqual(result);
  expect(store.conversations.get(thread.id).anchor?.target.versionSeq).toBe(3);
});
test("latest resolution finds shifted exact ranges and rejects ambiguous or missing matches without writes", async () => {
  const thread = await note();
  const match = await store.conversations.anchors.resolve(thread.id, 2);
  expect(match.state).toBe("anchored");
  expect(match.target).toEqual({ ...source(2), locator: { start: 3, end: 3, quote: "keep()" } });
  expect(store.conversations.get(thread.id).anchor).toBeNull();
  await publish(2, "keep()\nkeep()\n");
  expect((await store.conversations.anchors.resolve(thread.id, 3)).state).toBe("ambiguous");
  const exact = await store.conversations.add(id, {
    actor: human,
    body: "The second occurrence",
    target: {
      kind: "source",
      versionSeq: 3,
      path: "a.txt",
      locator: { start: 2, end: 2, quote: "keep()" },
    },
  });
  const sameVersion = await store.conversations.anchors.resolve(exact.id, 3);
  expect(sameVersion.state).toBe("anchored");
  expect(exact.target).toEqual(sameVersion.target!);

  await publish(3, "removed\n");
  expect((await store.conversations.anchors.resolve(thread.id, 4)).state).toBe("unplaced");
});
test("media anchors own snapshots independently of original and reply frames, and GC retains all live owners", async () => {
  const target = {
    kind: "media",
    versionSeq: 1,
    path: "image.png",
    locator: { time: null, box: { x: 0, y: 0, width: 1, height: 1 } },
  };
  const thread = await store.conversations.add(id, {
    actor: human,
    body: "Image",
    target,
    mediaSnapshot: image,
  });
  const comment = await store.conversations.addComment(thread.id, {
    actor: agent,
    body: "Fix",
    target: { ...target, versionSeq: 2 },
    mediaSnapshot: image,
    reanchor: { expectedSeq: 2, expectedAnchorRevision: 0 },
  });
  const moved = store.conversations.get(thread.id);
  if (
    moved.target.kind !== "media" ||
    moved.anchor?.target.kind !== "media" ||
    comment.target?.kind !== "media"
  )
    throw new Error("Expected media targets");
  const frames = [
    moved.target.locator.frame!,
    moved.anchor.target.locator.frame!,
    comment.target.locator.frame!,
  ];
  expect(new Set(frames.map((frame) => frame.id)).size).toBe(3);
  await store.collectBlobs();
  for (const frame of frames)
    expect((await store.artifacts.attachments.read(id, frame.id)).attachment.hash).toBe(frame.hash);
  await store.conversations.anchors.reanchor(id, batch(thread.id, 1, 2, "source"));
  await store.collectBlobs();
  await expect(store.artifacts.attachments.read(id, frames[1]!.id)).rejects.toThrow("not found");
  expect((await store.artifacts.attachments.read(id, frames[2]!.id)).attachment.id).toBe(
    frames[2]!.id,
  );
});
test("schema 17 upgrade leaves original and comment evidence intact without inferring anchors", async () => {
  const thread = await note();
  store.close();
  const db = new Database(join(root, "test.sqlite"));
  db.exec(
    "DROP TABLE thread_anchor_frames; DROP TABLE thread_anchor_operations; DROP TABLE thread_anchors; PRAGMA user_version=17",
  );
  db.close();
  store = await openArtifactStorage({ databasePath: join(root, "test.sqlite") });
  const migrated = store.conversations.get(thread.id);
  expect(migrated.target).toEqual(thread.target);
  expect(migrated.comments).toEqual(thread.comments);
  expect(migrated.anchor).toBeNull();
  expect(store.migration?.migrated).toBe(true);
});

test("general and resolved threads can receive a native destination without changing status", async () => {
  const thread = await store.conversations.add(id, {
    actor: human,
    body: "General",
    target: { kind: "artifact" },
  });
  await store.conversations.update(thread.id, { actor: human, status: "resolved" });
  await store.conversations.anchors.reanchor(id, batch(thread.id));
  const current = store.conversations.get(thread.id);
  expect(current.target).toEqual({ kind: "artifact" });
  expect(current.status).toBe("resolved");
  expect(current.anchor?.target.kind).toBe("source");
});

test("diff resolution retains its captured side and re-anchor ranges cannot bridge gaps", async () => {
  const diffId = store.artifacts.create({ kind: "diff", actor: human }).id;
  for (const [seq, start] of [
    [1, 1],
    [2, 10],
  ] as const) {
    await store.artifacts.publish(diffId, {
      actor: human,
      expectedSeq: seq - 1,
      publicationKey: `diff-${seq}`,
      content: {
        kind: "diff",
        patch: `diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -${start},1 +${start},1 @@\n-needle\n+replacement\n@@ -20,1 +20,1 @@\n-before\n+after\n`,
      },
    });
  }
  const thread = await store.conversations.add(diffId, {
    actor: human,
    body: "Old side",
    target: {
      kind: "diff",
      versionSeq: 1,
      path: "a.txt",
      locator: { side: "old", start: 1, end: 1, quote: "needle" },
    },
  });
  expect((await store.conversations.anchors.resolve(thread.id, 2)).target).toEqual({
    kind: "diff",
    versionSeq: 2,
    path: "a.txt",
    locator: { side: "old", start: 10, end: 10, quote: "needle" },
  });
  const input = {
    actor: human,
    expectedSeq: 2,
    operationKey: "diff-move",
    items: [
      {
        threadId: thread.id,
        expectedAnchorRevision: 0,
        target: {
          kind: "diff",
          versionSeq: 2,
          path: "a.txt",
          locator: { side: "new", start: 10, end: 20 },
        },
      },
    ],
  };
  await expect(store.conversations.anchors.reanchor(diffId, input)).rejects.toThrow("gap");
  input.items[0]!.target.locator.end = 10;
  await store.conversations.anchors.reanchor(diffId, input);
  expect(store.conversations.get(thread.id).target).toEqual(thread.target);
  const moved = store.conversations.get(thread.id).anchor?.target;
  expect(moved?.kind === "diff" && moved.locator?.side).toBe("new");
});

test("anchor routes retain authentication and origin guards, and deltas include anchors and actor labels", async () => {
  const thread = await note();
  const token = "isolated-anchor-test-token";
  const api = createArtifactApi(store, {
    token,
    version: "test",
    requireLogin: true,
    allowedHost: (host) => host === "localhost",
  });
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = { "x-r3-token": token },
  ) =>
    api.app.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers: { host: "localhost", "content-type": "application/json", ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  try {
    expect(
      (await request(`/api/threads/${thread.id}/anchor-resolution?version=2`, "GET", undefined, {}))
        .status,
    ).toBe(401);
    expect(
      (
        await request(`/api/artifacts/${id}/thread-anchors`, "POST", batch(thread.id), {
          "x-r3-token": token,
          origin: "null",
        })
      ).status,
    ).toBe(403);
    expect(store.conversations.get(thread.id).anchor).toBeNull();
    const before = await (await request(`/api/artifacts/${id}`)).json();
    expect(
      (await request(`/api/artifacts/${id}/thread-anchors`, "POST", batch(thread.id))).status,
    ).toBe(200);
    const delta = await (
      await request(`/api/artifacts/${id}?since=${encodeURIComponent(before.syncCursor)}`)
    ).json();
    expect(delta.delta).toBe(true);
    expect(delta.threads[0].anchor.revision).toBe(1);
    expect(Object.hasOwn(delta.agentLabels, agent.sessionId)).toBe(true);
    await request("/api/sessions", "POST", { id: agent.sessionId, label: "Anchor author" });
    const detail = await (await request(`/api/artifacts/${id}`)).json();
    expect(detail.agentLabels[agent.sessionId]).toBe("Anchor author");
    const resolution = await request(`/api/threads/${thread.id}/anchor-resolution?version=2`);
    expect(resolution.headers.get("cache-control")).toContain("no-store");
    expect((await resolution.json()).state).toBe("anchored");
  } finally {
    api.close();
  }
});
