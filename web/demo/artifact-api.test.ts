import { afterEach, expect, test } from "bun:test";
import { artifactApi } from "./artifact-api.ts";
import { demo } from "./artifact-backend.ts";

afterEach(() => demo.reset());

test("demo acknowledgments reject stale snapshots after edit and revert", async () => {
  const id = demo.state.artifacts[0].id;
  const note = demo.addDiscussion(id, "Original", { kind: "artifact" });
  const snapshot = await artifactApi.pendingDiscussion(id);
  await artifactApi.editDiscussion(note.id, { body: "Temporary" });
  await artifactApi.editDiscussion(note.id, { body: "Original" });
  await expect(
    artifactApi.acknowledgeDiscussion(id, snapshot.acknowledgment),
  ).rejects.toMatchObject({
    status: 409,
  });
  expect(demo.note(note.id).note.sentAt).toBeNull();
  const updated = await artifactApi.pendingDiscussion(id);
  await artifactApi.acknowledgeDiscussion(id, updated.acknowledgment);
  expect(demo.note(note.id).note.sentAt).not.toBeNull();
});

test("the demo human owner can edit agent messages without making them undelivered", async () => {
  const note = demo.state.artifacts[0].discussions[0];
  const sentAt = note.sentAt;
  await artifactApi.editDiscussion(note.id, { body: "Clarified agent note" });
  expect(demo.note(note.id).note.sentAt).toBe(sentAt);
  expect(demo.pending(note.artifactId)).toHaveLength(0);
  await artifactApi.deleteDiscussion(note.id);
  expect(demo.get(note.artifactId).discussions.some((item) => item.id === note.id)).toBe(false);
});

test("demo delivery acknowledges only the requested notes and emits presence updates", async () => {
  const id = demo.state.artifacts[0].id;
  const first = demo.addDiscussion(id, "First note", { kind: "artifact" });
  const second = demo.addDiscussion(id, "Second note", { kind: "artifact" });
  const events: string[] = [];
  const listener = (event: { type: string }) => events.push(event.type);
  demo.subscribers.add(listener);
  try {
    const snapshot = await artifactApi.pendingDiscussion(id, [first.id]);
    await artifactApi.acknowledgeDiscussion(id, snapshot.acknowledgment);
    expect(demo.note(first.id).note.sentAt).not.toBeNull();
    expect(demo.note(second.id).note.sentAt).toBeNull();
    expect(demo.note(second.id).note.claim).toBeNull();
    expect(events).toContain("presence-changed");
    expect((await artifactApi.pendingDiscussion(id)).text).toContain("Second note");
    expect((await artifactApi.pendingDiscussion(id)).text).not.toContain("First note");
    await artifactApi.editDiscussion(first.id, { status: "resolved" });
    demo.handoff(id, [first.id]);
    await artifactApi.editDiscussion(first.id, { body: "Edited after resolution" });
    expect(demo.pending(id).map((note) => note.id)).toEqual([second.id]);
  } finally {
    demo.subscribers.delete(listener);
  }
});

test("demo status handoff survives edits to delivered notes while new resolved notes stay quiet", async () => {
  const id = demo.state.artifacts[0].id;
  const delivered = demo.addDiscussion(id, "Delivered note", { kind: "artifact" });
  demo.handoff(id, [delivered.id]);
  await artifactApi.editDiscussion(delivered.id, { body: "Changed after delivery" });
  await artifactApi.editDiscussion(delivered.id, { status: "resolved" });
  expect(demo.pending(id).map((note) => note.id)).toEqual([delivered.id]);
  expect(demo.note(delivered.id).note.statusUnsent).toBe(true);
  demo.handoff(id, [delivered.id]);
  const fresh = demo.addDiscussion(id, "New note", { kind: "artifact" });
  await artifactApi.editDiscussion(fresh.id, { body: "Changed before delivery" });
  await artifactApi.editDiscussion(fresh.id, { status: "resolved" });
  expect(demo.pending(id)).toEqual([]);
  expect(demo.note(fresh.id).note.statusUnsent).toBe(false);
});

test("demo message retry keys deduplicate concurrent saves and reject changed content", async () => {
  const id = demo.state.artifacts[0].id;
  const save = () =>
    artifactApi.addDiscussion(
      id,
      "Retry note",
      { kind: "artifact" },
      { operationKey: "note-retry" },
    );
  const [first, retry] = await Promise.all([save(), save()]);
  expect(first.id).toBe(retry.id);
  await expect(
    artifactApi.addDiscussion(id, "Changed", { kind: "artifact" }, { operationKey: "note-retry" }),
  ).rejects.toMatchObject({ status: 409 });
  const body = {
    body: "Retry comment",
    context: { versionSeq: null, representation: null },
    operationKey: "comment-retry",
  };
  const [comment, retried] = await Promise.all([
    artifactApi.comment(first.id, body),
    artifactApi.comment(first.id, body),
  ]);
  expect(comment.id).toBe(retried.id);
  expect(demo.note(first.id).note.comments).toHaveLength(1);
});

test("demo usage keeps past activity when artifacts are deleted", async () => {
  const id = demo.state.artifacts[0].id;
  const before = await artifactApi.stat();
  await artifactApi.delete(id);
  const after = await artifactApi.stat();
  expect(after.artifacts.total).toBe(before.artifacts.total - 1);
  expect(after.periods).toEqual(before.periods);
  expect(after.contentBytes).toBeLessThanOrEqual(before.contentBytes);
  expect(await artifactApi.gc({ dryRun: true })).toMatchObject({ dryRun: true, deletedIds: [] });
});
