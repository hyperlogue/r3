import { expect, test } from "bun:test";
import { ArtifactDemoBackend } from "./artifact-backend.ts";

test("demo diff excerpts retain and retrieve the complete native range", () => {
  const backend = new ArtifactDemoBackend();
  try {
    const artifact = backend.state.artifacts.find((item) => item.kind === "diff")!;
    const file = backend
      .publication(artifact.id, 1)
      .fullDiff.find((file) => file.lines.some((row) => row.newLine === 1))!;
    const rows = file.lines.filter((row) => row.newLine !== null).slice(0, 5);
    const start = rows[0].newLine!;
    const end = rows.at(-1)!.newLine!;
    const quote = rows.find((row) => row.text.trim())!.text;
    const note = backend.addFeedback(artifact.id, "Full range", {
      kind: "diff",
      versionSeq: 1,
      path: file.path,
      locator: { side: "new", start, end, quote },
    });
    expect(backend.feedbackSource(note.id).text).toBe(rows.map((row) => row.text).join("\n"));
    expect(backend.note(note.id).note.sentAt).toBeNull();
  } finally {
    backend.close();
  }
});

test("demo targets match their published source and diff, and reads retain prior versions", async () => {
  const backend = new ArtifactDemoBackend();
  try {
    for (const artifact of backend.state.artifacts) {
      expect(backend.pending(artifact.id)).toEqual([]);
      for (const note of artifact.feedback) {
        backend.target(artifact.id, note.target);
        expect(note.sentAt).not.toBeNull();
        for (const reply of note.replies) {
          expect(reply.sentAt).not.toBeNull();
          expect(reply.context).toEqual({
            versionSeq: 1,
            representation: artifact.kind === "html" ? "rendered" : "diff",
          });
        }
      }
    }
    const id = backend.state.artifacts[0].id;
    const first = structuredClone(backend.publication(id, 1));
    const firstStorage = backend.get(id).storage;
    expect(firstStorage.totalBytes).toBeGreaterThan(0);
    expect(firstStorage.latestVersionBytes).toBe(firstStorage.totalBytes);
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
    expect(backend.get(id).storage.latestVersionBytes).toBeGreaterThan(
      firstStorage.latestVersionBytes,
    );
    expect(backend.get(id).storage.totalBytes).toBeGreaterThan(
      backend.get(id).storage.latestVersionBytes,
    );
    expect(backend.publication(id, 1)).toEqual(first);
    expect(backend.note(note.id).note.replies[0].context.versionSeq).toBe(2);
    expect(backend.note(note.id).note.status).toBe("open");
    expect(backend.note(note.id).note.claim).toBeNull();
    expect(backend.get(id).watching).toBe(true);
  } finally {
    backend.close();
  }
});

test("demo reset restores the seed and drops practice messages, images and pending agent work", async () => {
  const backend = new ArtifactDemoBackend();
  try {
    const id = backend.state.artifacts[0].id;
    const original = structuredClone(backend.state);
    backend.addFeedback(id, "Temporary practice note", { kind: "artifact" });
    backend.images.set("practice-image", { artifactId: id, blob: new Blob(["practice"]) });
    backend.handoff(id);
    backend.reset();
    expect(backend.images.size).toBe(0);
    expect(backend.state.artifacts).toEqual(original.artifacts);
    await Bun.sleep(1900);
    expect(backend.state.artifacts).toEqual(original.artifacts);
    expect(backend.pending(id)).toEqual([]);
  } finally {
    backend.close();
  }
});

test("demo archive retains unsent work and prevents in-flight replies and publication", async () => {
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
    expect(backend.note(note.id).note.replies).toHaveLength(0);
    expect(backend.note(pending.id).note.sentAt).toBeNull();
    backend.lifecycle(id, { event: "restored", operationKey: "restore-demo" });
    expect(backend.get(id).watching).toBe(false);
    expect(backend.pending(id).map((note) => note.id)).toEqual([pending.id]);
  } finally {
    backend.close();
  }
});
