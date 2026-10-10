import { expect, test } from "bun:test";
import type { ArtifactTarget } from "../../shared/artifacts.ts";
import { artifactFixture, artifactFixtureThread } from "./artifact-fixtures.ts";
import {
  artifactLocationSearch,
  artifactRegions,
  artifactWorkspaceSearch,
  defaultFileRepresentation,
  readArtifactLocation,
  visibleArtifactTargets,
} from "./artifact-navigation.ts";

test("Markdown defaults to rendered while explicit source links retain their native view", () => {
  for (const path of ["index.md", "notes/PLAN.MARKDOWN"]) {
    expect(defaultFileRepresentation(path)).toBe("rendered");
    expect(readArtifactLocation("files", `?file=${path}`).representation).toBe("rendered");
    expect(readArtifactLocation("files", `?file=${path}&view=source`).representation).toBe(
      "source",
    );
  }
  for (const path of ["index.html", "code.ts", "notes.md.txt"])
    expect(defaultFileRepresentation(path)).toBe("source");
});

test("saved discussion links retain their opaque thread and comment context", () => {
  const search =
    "?version=3&file=notes.md&view=rendered&discussions=discussion_kept&comment=comment_kept";
  const view = readArtifactLocation("files", search);
  expect(view.threadId).toBe("discussion_kept");
  const next = new URLSearchParams(artifactWorkspaceSearch(view, search));
  expect(next.get("thread")).toBe("discussion_kept");
  expect(next.has("discussions")).toBe(false);
  expect(next.get("comment")).toBe("comment_kept");
  expect(
    readArtifactLocation("files", "?thread=thread_new&discussions=discussion_kept").threadId,
  ).toBe("thread_new");
});

test("artifact links retain native view and unusual path characters, while fixed kinds cannot switch representations", () => {
  const location = { versionSeq: 7, path: "notes/a # b?.md", representation: "rendered" as const };
  expect(readArtifactLocation("files", artifactLocationSearch(location, "thread_example"))).toEqual(
    { ...location, threadId: "thread_example" },
  );
  expect(readArtifactLocation("html", "?view=source").representation).toBe("rendered");
  expect(readArtifactLocation("diff", "?view=rendered").representation).toBe("diff");
  expect(readArtifactLocation("files", "?version=9007199254740992").versionSeq).toBeNull();
  expect(readArtifactLocation("files", "?version=03").versionSeq).toBeNull();
});

test("rendered threads gain source highlights only through an explicit anchored placement", () => {
  expect(visibleArtifactTargets(artifactFixture, 1, "rendered")).toHaveLength(1);
  expect(artifactRegions(artifactFixture, 1, "source")).toEqual([]);
  const placed = {
    ...artifactFixture,
    placements: [
      {
        threadId: artifactFixtureThread.id,
        artifactId: artifactFixture.id,
        target: {
          kind: "source" as const,
          versionSeq: 2,
          path: "index.md",
          locator: { start: 4, end: 4, quote: "comparison" },
        },
        state: "anchored" as const,
        createdAt: artifactFixture.createdAt,
        updatedAt: artifactFixture.updatedAt,
      },
    ],
  };
  expect(artifactRegions(placed, 2, "source")).toEqual([
    {
      id: artifactFixtureThread.id,
      file: "index.md",
      start: 4,
      end: 4,
      side: "new",
      quote: "comparison",
    },
  ]);
  expect(artifactRegions(placed, 1, "source")).toEqual([]);
  expect(visibleArtifactTargets(placed, 1, "rendered")[0].target as ArtifactTarget).toBe(
    artifactFixtureThread.target,
  );
  expect(
    artifactRegions(
      {
        ...placed,
        placements: placed.placements.map((placement) => ({ ...placement, state: "ambiguous" })),
      },
      2,
      "source",
    ),
  ).toEqual([]);
});

test("search entry locations survive reload but clear on an explicit view change", async () => {
  const { artifactWorkspaceSearch } = await import("./artifact-navigation.ts");
  const view = {
    versionSeq: 2,
    path: "notes.txt",
    representation: "source" as const,
    threadId: null,
  };
  const original = "?version=2&file=notes.txt&view=source&line=81&library=%3Fq%3Dkeyboard";
  const retained = new URLSearchParams(artifactWorkspaceSearch(view, original));
  expect(retained.get("line")).toBe("81");
  expect(retained.get("library")).toBe("?q=keyboard");
  const moved = new URLSearchParams(artifactWorkspaceSearch({ ...view, versionSeq: 3 }, original));
  expect(moved.has("line")).toBe(false);
  expect(moved.get("library")).toBe("?q=keyboard");
});
