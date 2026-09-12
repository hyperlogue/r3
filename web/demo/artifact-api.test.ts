import { afterEach, expect, test } from "bun:test";
import { artifactApi } from "./artifact-api.ts";
import { demo } from "./artifact-backend.ts";

afterEach(() => demo.reset());

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
    await artifactApi.prompt(id, true, [first.id]);
    expect(demo.note(first.id).note.sentAt).not.toBeNull();
    expect(demo.note(second.id).note.sentAt).toBeNull();
    expect(demo.note(second.id).note.claim).toBeNull();
    expect(events).toContain("presence-changed");
    expect(await artifactApi.prompt(id)).toContain("Second note");
    expect(await artifactApi.prompt(id)).not.toContain("First note");
    await artifactApi.editFeedback(first.id, { status: "resolved" });
    demo.handoff(id, [first.id]);
    await artifactApi.editFeedback(first.id, { body: "Edited after resolution" });
    expect(demo.pending(id).map((note) => note.id)).toEqual([second.id]);
  } finally {
    demo.subscribers.delete(listener);
  }
});
