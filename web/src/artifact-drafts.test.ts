import { expect, test } from "bun:test";
import { ArtifactDraftStore } from "./artifact-drafts.ts";

function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}
test("draft target and reply context remain on their original publication while the pane moves", () => {
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
  store.beginReply("artifact_example", "feedback_example", {
    versionSeq: 1,
    representation: "rendered",
  });
  store.update("artifact_example", { body: "Reply about v1" }, "feedback_example");
  store.beginReply("artifact_example", "feedback_example", {
    versionSeq: 2,
    representation: "source",
  });
  store.flush();
  const reloaded = new ArtifactDraftStore(disk);
  expect(reloaded.get("artifact_example")?.target).toEqual(original);
  expect(reloaded.get("artifact_example", "feedback_example")?.context).toEqual({
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
      replies: { feedback_old: "Old reply" },
    }),
  );
  const store = new ArtifactDraftStore(disk);
  expect(store.get("review_imported")?.body).toContain("Anchored draft");
  expect(store.get("review_imported")?.imported).toBe(true);
  expect(store.get("review_imported")?.target).toEqual({ kind: "artifact" });
  expect(store.get("review_imported", "feedback_old")?.context.versionSeq).toBeNull();
  store.clear("review_imported");
  store.clear("review_imported", "feedback_old");
  store.flush();
  expect(new ArtifactDraftStore(disk).has("review_imported")).toBe(false);
  expect(disk.getItem("r3-draft-review_imported")).not.toBeNull();
});
