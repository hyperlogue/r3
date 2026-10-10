import { expect, test } from "bun:test";
import { ArtifactDraftStore } from "./artifact-drafts.ts";

test("image-only drafts retain native targets, survive reload, and block handoff", () => {
  const disk = storage();
  const drafts = new ArtifactDraftStore(disk);
  const target = { kind: "rendered", versionSeq: 1, path: "index.html", locator: null } as const;
  const image = {
    id: "draft-image",
    mediaType: "image/png",
    width: 160,
    height: 90,
    byteLength: 500,
  } as const;
  drafts.update("artifact_image", { target, attachments: [image] });
  expect(drafts.has("artifact_image")).toBe(true);
  expect(drafts.anchor("artifact_image", { ...target, versionSeq: 2 })).toBe(false);
  drafts.flush();
  const reloaded = new ArtifactDraftStore(disk);
  expect(reloaded.get("artifact_image")?.target).toEqual(target);
  expect(reloaded.get("artifact_image")?.attachments).toEqual([image]);
  reloaded.clear("artifact_image");
  reloaded.flush();
  expect(new ArtifactDraftStore(disk).has("artifact_image")).toBe(false);
});

function storage() {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
test("tabs editing different drafts do not overwrite each other", () => {
  const disk = storage();
  const first = new ArtifactDraftStore(disk);
  const second = new ArtifactDraftStore(disk);
  first.update("artifact_example", { body: "A shared note" });
  second.update("artifact_example", { body: "An independent comment" }, "thread_example");
  first.flush();
  second.flush();
  const reloaded = new ArtifactDraftStore(disk);
  expect(reloaded.get("artifact_example")?.body).toBe("A shared note");
  expect(reloaded.get("artifact_example", "thread_example")?.body).toBe("An independent comment");
});
test("the latest saved edit and discard reach other tabs without rewriting unrelated pending drafts", () => {
  const disk = storage();
  const first = new ArtifactDraftStore(disk);
  const second = new ArtifactDraftStore(disk);
  second.update("artifact_example", { body: "Pending comment" }, "thread_example");
  const comment = second.get("artifact_example", "thread_example");
  let notifications = 0;
  second.subscribe(() => notifications++);
  first.update("artifact_example", { body: "First note" });
  first.flush();
  const noteKey = disk.key(0)!;
  second.sync(noteKey);
  expect(second.get("artifact_example")?.body).toBe("First note");
  expect(second.get("artifact_example", "thread_example")).toBe(comment);
  expect(notifications).toBe(1);

  second.update("artifact_example", { body: "Latest note" });
  second.flush();
  // A delayed event for the first write must read the current stored value.
  second.sync(noteKey);
  first.sync(noteKey);
  expect(first.get("artifact_example")?.body).toBe("Latest note");
  expect(second.get("artifact_example")?.body).toBe("Latest note");
  expect(new ArtifactDraftStore(disk).get("artifact_example", "thread_example")?.body).toBe(
    "Pending comment",
  );

  first.clear("artifact_example");
  first.flush();
  second.sync(noteKey);
  second.flush();
  expect(second.get("artifact_example")).toBeNull();
  expect(new ArtifactDraftStore(disk).get("artifact_example")).toBeNull();
});

test("an incoming empty draft cannot erase text waiting for its debounce", () => {
  const disk = storage();
  const first = new ArtifactDraftStore(disk);
  const second = new ArtifactDraftStore(disk);
  second.beginComment("artifact_example", "thread_example", {
    versionSeq: 1,
    representation: "source",
  });
  first.update("artifact_example", { body: "Just typed" }, "thread_example");
  second.flush();
  first.sync(disk.key(0));
  expect(first.get("artifact_example", "thread_example")?.body).toBe("Just typed");
  first.flush();
  second.sync(disk.key(0));
  expect(second.get("artifact_example", "thread_example")?.body).toBe("Just typed");
});

test("a changed draft from another tab survives an older completed submission", () => {
  const disk = storage();
  const first = new ArtifactDraftStore(disk);
  first.update("artifact_example", { body: "Submitted text" });
  first.flush();
  const submitted = first.get("artifact_example")!;
  const second = new ArtifactDraftStore(disk);
  second.update("artifact_example", { body: "New text" });
  second.flush();
  first.sync(disk.key(0));
  expect(first.clearIfCurrent("artifact_example", submitted)).toBe(false);
  expect(first.get("artifact_example")?.body).toBe("New text");
});

test("per-draft saves preserve untouched older records and keep cleared drafts cleared", () => {
  const disk = storage();
  const draft = (body: string) => ({
    body,
    target: { kind: "artifact" },
    context: { versionSeq: null, representation: null },
  });
  disk.setItem(
    "r3-artifact-draft-artifact_example",
    JSON.stringify({
      note: draft("Old note"),
      comments: {
        thread_kept: draft("Keep this comment"),
        thread_cleared: draft("Discard this comment"),
      },
    }),
  );
  const store = new ArtifactDraftStore(disk);
  store.update("artifact_example", { body: "Updated note" });
  store.clear("artifact_example", "thread_cleared");
  store.flush();
  const reloaded = new ArtifactDraftStore(disk);
  expect(reloaded.get("artifact_example")?.body).toBe("Updated note");
  expect(reloaded.get("artifact_example", "thread_kept")?.body).toBe("Keep this comment");
  expect(reloaded.get("artifact_example", "thread_cleared")).toBeNull();
});

test("draft target and comment context remain on their original publication while the pane moves", () => {
  const disk = storage();
  const store = new ArtifactDraftStore(disk);
  const original = {
    kind: "rendered" as const,
    path: "index.md",
    versionSeq: 1,
    locator: { selector: "a", quote: "Link" },
  };
  expect(store.anchor("artifact_example", original)).toBe(true);
  store.update("artifact_example", { body: "A note about this link" });
  expect(store.anchor("artifact_example", { ...original, versionSeq: 2 })).toBe(false);
  store.beginComment("artifact_example", "thread_example", {
    versionSeq: 1,
    representation: "rendered",
  });
  store.update("artifact_example", { body: "Comment about v1" }, "thread_example");
  store.beginComment("artifact_example", "thread_example", {
    versionSeq: 2,
    representation: "source",
  });
  store.flush();
  const reloaded = new ArtifactDraftStore(disk);
  expect(reloaded.get("artifact_example")?.target).toEqual(original);
  expect(reloaded.get("artifact_example", "thread_example")?.context).toEqual({
    versionSeq: 1,
    representation: "rendered",
  });
  expect(reloaded.has("artifact_example")).toBe(true);
});
test("legacy draft text survives without inventing a publication target or reappearing after it was cleared", () => {
  const disk = storage();
  disk.setItem(
    "r3-draft-review_imported",
    JSON.stringify({
      general: "Saved note",
      text: "Anchored draft",
      anchor: { file: "notes.md", lineStart: 2 },
      comments: { thread_old: "Old comment" },
    }),
  );
  const store = new ArtifactDraftStore(disk);
  expect(store.get("review_imported")?.body).toContain("Anchored draft");
  expect(store.get("review_imported")?.imported).toBe(true);
  expect(store.get("review_imported")?.target).toEqual({ kind: "artifact" });
  expect(store.get("review_imported", "thread_old")?.context.versionSeq).toBeNull();
  store.clear("review_imported");
  store.clear("review_imported", "thread_old");
  store.flush();
  expect(new ArtifactDraftStore(disk).has("review_imported")).toBe(false);
  expect(disk.getItem("r3-draft-review_imported")).not.toBeNull();
});

test("deleted threads cannot leave an invisible draft blocking handoff", () => {
  const disk = storage();
  const store = new ArtifactDraftStore(disk);
  store.update("artifact_example", { body: "Keep this note" });
  store.update("artifact_example", { body: "Deleted thread comment" }, "thread_deleted");
  store.update("artifact_example", { body: "Resolved thread comment" }, "thread_resolved");
  store.pruneComments("artifact_example", new Set(["thread_resolved"]));
  store.flush();
  const reloaded = new ArtifactDraftStore(disk);
  expect(reloaded.count("artifact_example")).toBe(2);
  expect(reloaded.get("artifact_example", "thread_deleted")).toBeNull();
  expect(reloaded.get("artifact_example", "thread_resolved")?.body).toBe("Resolved thread comment");
});

test("a completed save cannot discard a newer note or comment draft, including edit and revert", () => {
  const disk = storage();
  const store = new ArtifactDraftStore(disk);
  for (const commentTo of [undefined, "thread_example"]) {
    store.update("artifact_example", { body: "Submitted text" }, commentTo);
    const submitted = store.get("artifact_example", commentTo)!;
    store.update("artifact_example", { body: "New text" }, commentTo);
    expect(store.clearIfCurrent("artifact_example", submitted, commentTo)).toBe(false);
    expect(store.get("artifact_example", commentTo)?.body).toBe("New text");
    store.update("artifact_example", { body: "Submitted text" }, commentTo);
    expect(store.clearIfCurrent("artifact_example", submitted, commentTo)).toBe(false);
  }
  store.flush();
  const reloaded = new ArtifactDraftStore(disk);
  expect(reloaded.get("artifact_example")?.body).toBe("Submitted text");
  expect(reloaded.get("artifact_example", "thread_example")?.body).toBe("Submitted text");
});

test("a completed save clears its unchanged draft while preserving other draft slots", () => {
  const store = new ArtifactDraftStore(storage());
  store.update("artifact_example", { body: "Submitted note" });
  const submitted = store.get("artifact_example")!;
  store.update("artifact_example", { body: "Independent comment" }, "thread_example");
  expect(store.clearIfCurrent("artifact_example", submitted)).toBe(true);
  expect(store.get("artifact_example")).toBeNull();
  expect(store.get("artifact_example", "thread_example")?.body).toBe("Independent comment");
  const comment = store.get("artifact_example", "thread_example")!;
  expect(store.clearIfCurrent("artifact_example", comment, "thread_example")).toBe(true);
  store.flush();
});

test("reloaded image preparation becomes a removable error without losing draft text", () => {
  const disk = storage();
  const drafts = new ArtifactDraftStore(disk);
  drafts.update("artifact_image", {
    body: "Keep this",
    attachments: [
      { id: "pending", mediaType: "image/png", width: 0, height: 0, byteLength: 0, pending: true },
    ],
  });
  drafts.flush();
  const recovered = new ArtifactDraftStore(disk).get("artifact_image")!;
  expect(recovered.body).toBe("Keep this");
  expect(recovered.attachments![0]!.pending).toBe(false);
  expect(recovered.attachments![0]!.error).toContain("interrupted");
});
