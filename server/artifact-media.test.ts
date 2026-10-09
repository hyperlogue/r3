import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discussionAttachments } from "../shared/artifact-prompt.ts";
import type { ArtifactMediaTarget } from "../shared/artifacts.ts";
import { createArtifactApi } from "./artifact-api.ts";
import { ATTACHMENT_SCHEMA } from "./artifact-attachments.ts";
import { ArtifactConversations } from "./artifact-conversations.ts";
import { ARTIFACT_SCHEMA } from "./artifact-schema.ts";
import { type ArtifactStorage, openArtifactStorage } from "./artifact-storage.ts";
import { installArtifactUsage } from "./artifact-usage-schema.ts";
import { ArtifactStore } from "./artifacts.ts";
import { BlobStore } from "./blobs.ts";
import { upgradeArtifactStore } from "./migration.ts";

const png = {
  mediaType: "image/png",
  base64:
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4HyD3H4QZYAwAV6YJsVhH600AAAAASUVORK5CYII=",
};
const human = { role: "human", sessionId: null } as const;
let store: ArtifactStorage;
let root: string;
afterEach(async () => {
  store?.close();
  if (root) await rm(root, { recursive: true, force: true });
});
async function setup() {
  root = await mkdtemp(join(tmpdir(), "r3-media-"));
  store = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
  const artifact = store.artifacts.create({ kind: "files", actor: human });
  for (const seq of [1, 2])
    await store.artifacts.publish(artifact.id, {
      actor: human,
      expectedSeq: seq - 1,
      publicationKey: `v${seq}`,
      content: {
        kind: "files",
        files: [
          { path: "image.png", ...png },
          {
            path: "film.mp4",
            mediaType: "video/mp4",
            base64: Buffer.from("published video bytes").toString("base64"),
          },
        ],
      },
    });
  return artifact.id;
}
const target = (time: number | null = 4.800123456): ArtifactMediaTarget => ({
  kind: "media",
  versionSeq: 1,
  path: time === null ? "image.png" : "film.mp4",
  locator: { time, box: { x: 0.1, y: 0.6, width: 0.8, height: 0.2 } },
});

test("media evidence survives message edits, delivery, restart and blob collection", async () => {
  const id = await setup();
  const input = {
    actor: human,
    body: "Fix this caption",
    target: target(),
    mediaSnapshot: png,
    operationKey: "capture",
  };
  const note = await store.conversations.add(id, input);
  expect((await store.conversations.add(id, input)).id).toBe(note.id);
  const saved = note.target as ArtifactMediaTarget;
  expect(saved.locator.time).toBe(4.800123456);
  expect(saved.locator.frame?.width).toBe(2);
  expect(note.attachments).toEqual([]);
  expect(discussionAttachments([note])).toEqual([saved.locator.frame!]);
  await store.conversations.update(note.id, {
    actor: human,
    body: "Changed text",
    attachments: [],
  });
  expect(store.conversations.get(note.id).target).toEqual(saved);
  const other = await store.conversations.add(id, {
    actor: human,
    body: "Other",
    target: { kind: "artifact" },
  });
  await expect(
    store.conversations.update(other.id, {
      actor: human,
      attachments: [{ id: saved.locator.frame!.id }],
    }),
  ).rejects.toThrow("does not belong");
  await store.collectBlobs();
  expect(
    (await store.artifacts.attachments.read(id, saved.locator.frame!.id)).bytes.toString("base64"),
  ).toBe(png.base64);
  store.close();
  store = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
  expect(store.conversations.get(note.id).target).toEqual(saved);
  const snapshot = store.conversations.snapshot(id);
  store.conversations.acknowledge(id, snapshot.acknowledgment);
  expect(discussionAttachments([store.conversations.get(note.id)], true)).toContainEqual(
    saved.locator.frame!,
  );
  store.conversations.delete(note.id, human);
  await expect(store.artifacts.attachments.read(id, saved.locator.frame!.id)).rejects.toThrow(
    "not found",
  );
});

test("media targets validate one instant, normalized geometry, file membership and required evidence", async () => {
  const id = await setup();
  const add = (value: unknown, snapshot: unknown = png) =>
    store.conversations.add(id, {
      actor: human,
      body: "Review",
      target: value,
      mediaSnapshot: snapshot,
    });
  for (const time of [-1, Infinity, "4", [4, 5], null])
    await expect(add({ ...target(), locator: { ...target().locator, time } })).rejects.toThrow();
  for (const box of [
    { x: -0.1, y: 0, width: 1, height: 1 },
    { x: 0.8, y: 0, width: 0.8, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 },
  ])
    await expect(add({ ...target(), locator: { ...target().locator, box } })).rejects.toThrow(
      "box",
    );
  await expect(add({ ...target(), versionSeq: 9 })).rejects.toThrow();
  await expect(add({ ...target(), path: "absent.mp4" })).rejects.toThrow();
  await expect(add(target(), null)).rejects.toThrow("snapshot");
  await expect(add(target(), { id: "image_saved" })).rejects.toThrow("own");
  const note = await add({ ...target(null), locator: { time: null } });
  expect((note.target as ArtifactMediaTarget).locator.box).toEqual({
    x: 0,
    y: 0,
    width: 1,
    height: 1,
  });
  await expect(add({ ...target(null), locator: { time: 1 } })).rejects.toThrow("timestamp");
});

test("agent fix frames remain independent and authenticated reads expose the exact evidence", async () => {
  const id = await setup();
  const session = store.artifacts.registerSession({ id: "media-agent" });
  const actor = { role: "agent", sessionId: session.id } as const;
  const note = await store.conversations.add(id, {
    actor: human,
    body: "Fix",
    target: target(),
    mediaSnapshot: png,
  });
  store.conversations.claim([note.id], session.id);
  const comment = await store.conversations.addComment(note.id, {
    actor,
    body: "Fixed",
    context: { versionSeq: 1, representation: "source" },
    target: { ...target(6.300123), versionSeq: 2 },
    mediaSnapshot: png,
  });
  expect((comment.target as ArtifactMediaTarget).locator.time).toBe(6.300123);
  expect(comment.context).toEqual({ versionSeq: 2, representation: "media" });
  expect(store.conversations.get(note.id).claim).toBeNull();
  expect(store.conversations.get(note.id).status).toBe("open");
  const token = randomBytes(32).toString("base64url");
  const api = createArtifactApi(store, {
    token,
    requireLogin: false,
    version: "test",
    allowedHost: () => true,
  });
  try {
    const frame = (comment.target as ArtifactMediaTarget).locator.frame!;
    const path = `http://localhost/api/artifacts/${id}/attachments/${frame.id}`;
    expect((await api.app.request(path, { headers: { host: "localhost" } })).status).toBe(401);
    const response = await api.app.request(path, {
      headers: { host: "localhost", "x-r3-token": token },
    });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(png.base64);
  } finally {
    api.close();
  }
});

test("version 9 constraint upgrade retains conversations and restores foreign keys", async () => {
  root = await mkdtemp(join(tmpdir(), "r3-media-upgrade-"));
  const db = new Database(":memory:");
  try {
    // Reproduce old constraints instead of labeling a current schema as old.
    const old = ARTIFACT_SCHEMA.replaceAll(", 'media'", "");
    db.exec(old);
    db.exec(ATTACHMENT_SCHEMA);
    installArtifactUsage(db, null);
    const artifacts = new ArtifactStore(db, new BlobStore(join(root, "blobs")), async (text) => ({
      html: text,
      revision: "test",
    }));
    const conversations = new ArtifactConversations(db, artifacts);
    const artifact = artifacts.create({ kind: "files", actor: human });
    await artifacts.publish(artifact.id, {
      actor: human,
      expectedSeq: 0,
      publicationKey: "before",
      content: { kind: "files", files: [{ path: "image.png", ...png }] },
    });
    const note = await conversations.add(artifact.id, {
      actor: human,
      body: "Keep this note",
      target: { kind: "source", versionSeq: 1, path: "image.png", locator: null },
      attachments: [png],
    });
    await conversations.addComment(note.id, {
      actor: human,
      body: "Keep this comment",
      context: { versionSeq: 1, representation: "source" },
    });
    const before = conversations.get(note.id);
    const activity = db.query("SELECT * FROM artifact_activity ORDER BY occurred_at, metric").all();
    db.exec(
      "DROP INDEX target_frame_discussions; DROP INDEX target_frame_comment; DROP TRIGGER immutable_message_attachment; ALTER TABLE message_attachments DROP COLUMN purpose; PRAGMA user_version = 9",
    );
    await upgradeArtifactStore(db, { backupPath: join(root, "backup.sqlite") });
    expect(db.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(conversations.get(note.id)).toEqual(before);
    expect(db.query("SELECT * FROM artifact_activity ORDER BY occurred_at, metric").all()).toEqual(
      activity,
    );
    expect(db.query("SELECT purpose FROM message_attachments").get()).toEqual({
      purpose: "message",
    });
    await conversations.add(artifact.id, {
      actor: human,
      body: "New media target",
      target: { kind: "media", versionSeq: 1, path: "image.png", locator: { time: null } },
      mediaSnapshot: png,
    });
    const tables = db
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE name IN ('discussions', 'comments', 'discussion_placements')",
      )
      .all();
    expect(tables.every((table) => table.sql.includes("'media'"))).toBe(true);
  } finally {
    db.close();
  }
});
