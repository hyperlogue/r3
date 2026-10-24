import { expect, test } from "bun:test";
import { artifactFixture, artifactFixtureVersion } from "./artifact-fixtures.ts";
import { ArtifactWorkspaceSelections } from "./artifact-workspace-state.ts";

const detail = {
  ...artifactFixture,
  versions: [artifactFixtureVersion, { ...artifactFixtureVersion, seq: 2 }],
};
const selected = {
  versionSeq: 2,
  path: "notes/a # b?.md",
  representation: "source" as const,
  threadId: artifactFixture.threads[0].id,
};
const storage = () => {
  let value: string | null = null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => {
      value = next;
    },
  };
};

test("reload restores the tab selection without following the thread's older original target", () => {
  const tab = storage();
  new ArtifactWorkspaceSelections(() => tab).save(detail.id, selected);
  const reload = new ArtifactWorkspaceSelections(() => tab);
  expect(reload.restore(detail, "?version=2")).toEqual(selected);
  expect(reload.restore(detail, "")).toEqual(selected);
  expect(new ArtifactWorkspaceSelections(storage).restore(detail, "?version=2")).toEqual({
    versionSeq: 2,
    path: null,
    representation: "source",
    threadId: null,
  });
});

test("selection belongs to its artifact and version; explicit missing versions stay missing", () => {
  const selections = new ArtifactWorkspaceSelections(storage);
  selections.save(detail.id, selected);
  for (const seq of [1, 99])
    expect(selections.restore(detail, `?version=${seq}`)).toEqual({
      versionSeq: seq,
      path: null,
      representation: "source",
      threadId: null,
    });
  expect(selections.restore({ ...detail, id: "artifact_other" }, "?version=2").path).toBeNull();
  expect(selections.restore({ ...detail, threads: [] }, "?version=2").threadId).toBeNull();
  selections.forget(detail.id);
  expect(selections.restore(detail, "?version=2").path).toBeNull();
});

test("unavailable or malformed browser storage does not break navigation", () => {
  const blocked = new ArtifactWorkspaceSelections(() => {
    throw new Error("storage blocked");
  });
  blocked.save(detail.id, selected);
  expect(blocked.restore(detail, "?version=2")).toEqual(selected);
  for (const value of [
    "{",
    "null",
    "[null, 1]",
    JSON.stringify([[detail.id, { ...selected, versionSeq: "2" }]]),
  ]) {
    const malformed = new ArtifactWorkspaceSelections(() => ({
      getItem: () => value,
      setItem() {},
    }));
    expect(malformed.restore(detail, "?version=2").path).toBeNull();
  }
});
