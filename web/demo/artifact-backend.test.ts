import { expect, test } from "bun:test";
import { ArtifactDemoBackend } from "./artifact-backend.ts";

test("demo targets match their published source and diff, and reads retain prior versions", async () => {
  const backend = new ArtifactDemoBackend();
  try {
    for (const artifact of backend.state.artifacts)
      for (const note of artifact.feedback) backend.target(artifact.id, note.target);
    const id = backend.state.artifacts[0].id;
    const first = structuredClone(backend.publication(id, 1));
    expect(() =>
      backend.addFeedback(id, "Description note", {
        kind: "version_summary",
        versionSeq: 1,
        locator: null,
      }),
    ).toThrow("read-only historical evidence");
    const note = backend.addFeedback(id, "Keep the original version available", {
      kind: "artifact",
    });
    expect(backend.note(note.id).note.sentAt).toBeNull();
    backend.handoff(id);
    expect(backend.note(note.id).note.claim).not.toBeNull();
    await Bun.sleep(1900);
    expect(backend.get(id).versions).toHaveLength(2);
    expect(backend.publication(id, 1)).toEqual(first);
    expect(backend.note(note.id).note.replies[0].context.versionSeq).toBe(2);
    expect(backend.note(note.id).note.status).toBe("open");
    expect(backend.note(note.id).note.claim).toBeNull();
    expect(backend.get(id).watching).toBe(true);
  } finally {
    backend.close();
  }
});

test("demo archive retains unsent work and in-flight replies without publishing or re-registering", async () => {
  const backend = new ArtifactDemoBackend();
  try {
    const id = backend.state.artifacts[0].id;
    const note = backend.addFeedback(id, "Explain this", { kind: "artifact" });
    backend.handoff(id);
    const pending = backend.addFeedback(id, "Keep this for later", { kind: "artifact" });
    const command = {
      event: "archived" as const,
      operationKey: "archive-demo",
      message: "Save this history",
    };
    const first = backend.lifecycle(id, command);
    expect(backend.lifecycle(id, command).event).toEqual(first.event);
    expect(backend.get(id).watching).toBe(false);
    await Bun.sleep(1900);
    expect(backend.get(id).versions).toHaveLength(1);
    expect(backend.note(note.id).note.replies).toHaveLength(1);
    expect(backend.note(pending.id).note.sentAt).toBeNull();
    backend.lifecycle(id, { event: "restored", operationKey: "restore-demo" });
    expect(backend.get(id).watching).toBe(false);
    expect(backend.pending(id).map((note) => note.id)).toEqual([pending.id]);
  } finally {
    backend.close();
  }
});
