import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactApi } from "./artifact-api.ts";
import { type ArtifactStorage, openArtifactStorage } from "./artifact-storage.ts";
import { prepareAttachmentImage } from "./attachment-image.ts";

const base64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4HyD3H4QZYAwAV6YJsVhH600AAAAASUVORK5CYII=";
const image = { base64, mediaType: "image/png" };
const human = { role: "human", sessionId: null } as const;
const roots: string[] = [];
const stores: ArtifactStorage[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "r3-images-"));
  roots.push(root);
  const databasePath = join(root, "store.sqlite");
  const store = await openArtifactStorage({ databasePath });
  stores.push(store);
  const artifact = store.artifacts.create({ kind: "html", actor: human });
  return { store, artifact, databasePath };
}

test("image-only messages survive restart, retain immutable bytes and participate in GC", async () => {
  const { store, artifact, databasePath } = await setup();
  const note = await store.conversations.add(artifact.id, {
    actor: human,
    body: "",
    target: { kind: "artifact" },
    attachments: [image],
  });
  const comment = await store.conversations.addComment(note.id, {
    actor: human,
    body: "",
    context: { versionSeq: null, representation: null },
    attachments: [image],
  });
  expect(note.attachments![0]!.hash).toBe(comment.attachments![0]!.hash);
  expect(store.artifacts.get(artifact.id).storage.attachmentBytes).toBe(
    Buffer.from(base64, "base64").length,
  );
  await store.collectBlobs();
  expect(
    (await store.artifacts.attachments.read(artifact.id, note.attachments![0]!.id)).bytes.toString(
      "base64",
    ),
  ).toBe(base64);
  store.close();
  stores.splice(stores.indexOf(store), 1);
  const reopened = await openArtifactStorage({ databasePath });
  stores.push(reopened);
  expect(reopened.conversations.get(note.id).attachments).toEqual(note.attachments);
  expect(reopened.conversations.comment(comment.id).attachments).toEqual(comment.attachments);
  reopened.conversations.delete(note.id, human);
  expect(await reopened.collectBlobs()).toBe(1);
  await expect(
    reopened.artifacts.attachments.read(artifact.id, note.attachments![0]!.id),
  ).rejects.toThrow("not found");
});

test("image edits are atomic, scoped to their message and invalidate delivery snapshots", async () => {
  const { store, artifact } = await setup();
  const input = {
    actor: human,
    body: "",
    target: { kind: "artifact" },
    attachments: [image],
    operationKey: "retry-image",
  };
  const note = await store.conversations.add(artifact.id, input);
  expect((await store.conversations.add(artifact.id, input)).id).toBe(note.id);
  await expect(store.conversations.add(artifact.id, { ...input, body: "changed" })).rejects.toThrow(
    "different message",
  );
  const snapshot = store.conversations.snapshot(artifact.id);
  store.conversations.acknowledge(artifact.id, snapshot.acknowledgment);
  const old = store.conversations.snapshot(artifact.id);
  await expect(
    store.conversations.update(note.id, { actor: human, attachments: [] }),
  ).rejects.toThrow("needs text or an image");
  expect(store.conversations.get(note.id).attachments).toEqual(note.attachments);
  await store.conversations.update(note.id, { actor: human, attachments: [image] });
  expect(store.conversations.get(note.id).sentAt).toBeNull();
  expect(() => store.conversations.acknowledge(artifact.id, old.acknowledgment)).toThrow("changed");
  const other = await store.conversations.add(artifact.id, {
    actor: human,
    body: "Other",
    target: { kind: "artifact" },
  });
  await expect(
    store.conversations.update(other.id, {
      actor: human,
      attachments: [{ id: store.conversations.get(note.id).attachments![0]!.id }],
    }),
  ).rejects.toThrow("does not belong");
  await expect(
    store.conversations.add(artifact.id, {
      ...input,
      operationKey: "bad",
      attachments: [image, { ...image, base64: "bad" }],
    }),
  ).rejects.toThrow();
  expect(store.conversations.list(artifact.id)).toHaveLength(2);
});

test("attachment HTTP reads require authentication and exact artifact membership", async () => {
  const { store, artifact } = await setup();
  const note = await store.conversations.add(artifact.id, {
    actor: human,
    body: "Image",
    target: { kind: "artifact" },
    attachments: [image],
  });
  const token = crypto.randomUUID();
  const api = createArtifactApi(store, {
    token,
    requireLogin: false,
    version: "test",
    allowedHost: (host) => host === "localhost",
  });
  try {
    const path = `/api/artifacts/${artifact.id}/attachments/${note.attachments![0]!.id}`;
    const read = (path: string, authenticated = true, extra = {}) =>
      api.app.fetch(
        new Request(`http://localhost${path}`, {
          headers: {
            host: "localhost",
            ...(authenticated ? { "x-r3-token": token } : {}),
            ...extra,
          },
        }),
      );
    expect((await read(path, false)).status).toBe(401);
    expect((await read(path.replace(artifact.id, "another-artifact"))).status).toBe(404);
    expect((await read(path, true, { Origin: "null" })).status).toBe(403);
    const response = await read(path);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(Buffer.from(await response.arrayBuffer()).toString("base64")).toBe(base64);
  } finally {
    api.close();
  }
});

test("version 6 stores gain empty attachment membership without rewriting conversations", async () => {
  const { store, artifact, databasePath } = await setup();
  const note = await store.conversations.add(artifact.id, {
    actor: human,
    body: "Keep this",
    target: { kind: "artifact" },
  });
  store.close();
  stores.splice(stores.indexOf(store), 1);
  const db = new Database(databasePath);
  db.exec("DROP TABLE message_operations; DROP TABLE message_attachments; PRAGMA user_version = 6");
  db.close();
  const reopened = await openArtifactStorage({ databasePath });
  stores.push(reopened);
  expect(reopened.conversations.get(note.id)).toEqual(note);
  expect(reopened.migration?.migrated).toBe(true);
});

test("image validation rejects executable, corrupt, truncated and oversized input", () => {
  const bytes = Buffer.from(base64, "base64");
  expect(prepareAttachmentImage(bytes, "image/png").width).toBe(2);
  expect(() => prepareAttachmentImage(bytes, "image/svg+xml")).toThrow();
  expect(() =>
    prepareAttachmentImage(Buffer.from("<svg onload='alert(1)'/>"), "image/png"),
  ).toThrow();
  expect(() => prepareAttachmentImage(bytes.subarray(0, bytes.length - 1), "image/png")).toThrow();
  const corrupt = Buffer.from(bytes);
  corrupt[45] = 0;
  expect(() => prepareAttachmentImage(corrupt, "image/png")).toThrow();
  expect(() => prepareAttachmentImage(Buffer.alloc(5 * 1024 * 1024 + 1), "image/png")).toThrow(
    "5 MiB",
  );
});
