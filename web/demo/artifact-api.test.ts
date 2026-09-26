import { afterEach, expect, test } from "bun:test";
import { artifactApi } from "./artifact-api.ts";
import { demo } from "./artifact-backend.ts";

afterEach(() => demo.reset());

test("demo acknowledgments reject stale snapshots after edit and revert", async () => {
  const id = demo.state.artifacts[0].id;
  const note = demo.addFeedback(id, "Original", { kind: "artifact" });
  const snapshot = await artifactApi.pendingFeedback(id);
  await artifactApi.editFeedback(note.id, { body: "Temporary" });
  await artifactApi.editFeedback(note.id, { body: "Original" });
  await expect(artifactApi.acknowledgeFeedback(id, snapshot.acknowledgment)).rejects.toMatchObject({
    status: 409,
  });
  expect(demo.note(note.id).note.sentAt).toBeNull();
  const updated = await artifactApi.pendingFeedback(id);
  await artifactApi.acknowledgeFeedback(id, updated.acknowledgment);
  expect(demo.note(note.id).note.sentAt).not.toBeNull();
});

test("the demo human owner can edit agent messages without making them undelivered", async () => {
  const note = demo.state.artifacts[0].feedback[0];
  const sentAt = note.sentAt;
  await artifactApi.editFeedback(note.id, { body: "Clarified agent note" });
  expect(demo.note(note.id).note.sentAt).toBe(sentAt);
  expect(demo.pending(note.artifactId)).toHaveLength(0);
  await artifactApi.deleteFeedback(note.id);
  expect(demo.get(note.artifactId).feedback).toHaveLength(0);
});

test("demo delivery acknowledges only the requested notes and emits presence updates", async () => {
  const id = demo.state.artifacts[0].id;
  const first = demo.addFeedback(id, "First note", { kind: "artifact" });
  const second = demo.addFeedback(id, "Second note", { kind: "artifact" });
  const events: string[] = [];
  const listener = (event: { type: string }) => events.push(event.type);
  demo.subscribers.add(listener);
  try {
    const snapshot = await artifactApi.pendingFeedback(id, [first.id]);
    await artifactApi.acknowledgeFeedback(id, snapshot.acknowledgment);
    expect(demo.note(first.id).note.sentAt).not.toBeNull();
    expect(demo.note(second.id).note.sentAt).toBeNull();
    expect(demo.note(second.id).note.claim).toBeNull();
    expect(events).toContain("presence-changed");
    expect((await artifactApi.pendingFeedback(id)).text).toContain("Second note");
    expect((await artifactApi.pendingFeedback(id)).text).not.toContain("First note");
    await artifactApi.editFeedback(first.id, { status: "resolved" });
    demo.handoff(id, [first.id]);
    await artifactApi.editFeedback(first.id, { body: "Edited after resolution" });
    expect(demo.pending(id).map((note) => note.id)).toEqual([second.id]);
  } finally {
    demo.subscribers.delete(listener);
  }
});

test("demo status handoff survives edits to delivered notes while new resolved notes stay quiet", async () => {
  const id = demo.state.artifacts[0].id;
  const delivered = demo.addFeedback(id, "Delivered note", { kind: "artifact" });
  demo.handoff(id, [delivered.id]);
  await artifactApi.editFeedback(delivered.id, { body: "Changed after delivery" });
  await artifactApi.editFeedback(delivered.id, { status: "resolved" });
  expect(demo.pending(id).map((note) => note.id)).toEqual([delivered.id]);
  expect(demo.note(delivered.id).note.statusUnsent).toBe(true);
  demo.handoff(id, [delivered.id]);
  const fresh = demo.addFeedback(id, "New note", { kind: "artifact" });
  await artifactApi.editFeedback(fresh.id, { body: "Changed before delivery" });
  await artifactApi.editFeedback(fresh.id, { status: "resolved" });
  expect(demo.pending(id)).toEqual([]);
  expect(demo.note(fresh.id).note.statusUnsent).toBe(false);
});
