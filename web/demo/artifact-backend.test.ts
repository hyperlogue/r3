import { expect, test } from "bun:test";
import { ArtifactDemoBackend } from "./artifact-backend.ts";

test("demo targets match their published source and diff, and reads retain prior versions", async () => {
  const backend = new ArtifactDemoBackend();
  try {
    for (const artifact of backend.state.artifacts)
      for (const note of artifact.feedback) backend.target(artifact.id, note.target);
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

test("saved demos gain storage accounting without losing their conversations", () => {
  const backend = new ArtifactDemoBackend();
  const id = backend.state.artifacts[0].id;
  const note = backend.addFeedback(id, "Keep this saved note", { kind: "artifact" });
  const snapshot = JSON.stringify(backend.state, (key, value) =>
    ["storage", "storageBlobs", "patchBytes"].includes(key) ? undefined : value,
  );
  const restored = new ArtifactDemoBackend({ getItem: () => snapshot, setItem: () => {} });
  expect(restored.get(id).storage).toEqual(backend.get(id).storage);
  expect(restored.note(note.id).note.body).toBe("Keep this saved note");
  backend.close();
  restored.close();
});

test("demo delivery history survives reload and old saves conservatively retain unknown history", () => {
  const backend = new ArtifactDemoBackend();
  const id = backend.state.artifacts[0].id;
  const note = backend.addFeedback(id, "Delivered", { kind: "artifact" });
  backend.handoff(id, [note.id]);
  backend.note(note.id).note.sentAt = null;
  const fresh = backend.addFeedback(id, "Never delivered", { kind: "artifact" });
  let snapshot = JSON.stringify(backend.state);
  const storage = {
    getItem: () => snapshot,
    setItem: (_key: string, value: string) => {
      snapshot = value;
    },
  };
  const restored = new ArtifactDemoBackend(storage);
  expect(restored.state.everDelivered[note.id]).toBe(true);
  expect(restored.state.everDelivered[fresh.id]).toBe(false);
  snapshot = JSON.stringify({ ...backend.state, schema: 2, everDelivered: undefined });
  const upgraded = new ArtifactDemoBackend(storage);
  expect(upgraded.state.everDelivered[note.id]).toBe(true);
  expect(upgraded.state.everDelivered[fresh.id]).toBe(true);
  expect(upgraded.note(note.id).note.sentAt).toBeNull();
  expect(upgraded.note(fresh.id).note.sentAt).toBeNull();
  const created = upgraded.addFeedback(id, "New after upgrade", { kind: "artifact" });
  expect(upgraded.state.everDelivered[created.id]).toBe(false);
  backend.close();
  restored.close();
  upgraded.close();
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

test("older saved demos gain the HTML sample once without losing notes or undoing deletion", () => {
  const backend = new ArtifactDemoBackend();
  const note = backend.addFeedback("artifact_code", "Keep this note", { kind: "artifact" });
  backend.state.schema = 1;
  backend.state.artifacts = backend.state.artifacts.filter(
    (item) => item.id !== "artifact_weekend",
  );
  delete backend.state.publications["artifact_weekend/1"];
  delete backend.state.pending.artifact_weekend;
  let snapshot = JSON.stringify(backend.state);
  const storage = {
    getItem: () => snapshot,
    setItem: (_key: string, value: string) => {
      snapshot = value;
    },
  };
  const upgraded = new ArtifactDemoBackend(storage);
  expect(upgraded.get("artifact_weekend").kind).toBe("html");
  expect(upgraded.note(note.id).note.body).toBe("Keep this note");
  upgraded.state.artifacts = upgraded.state.artifacts.filter(
    (item) => item.id !== "artifact_weekend",
  );
  upgraded.persist();
  const restored = new ArtifactDemoBackend(storage);
  expect(() => restored.get("artifact_weekend")).toThrow("Artifact not found");
  backend.close();
  upgraded.close();
  restored.close();
});
