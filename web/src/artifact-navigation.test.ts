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

test("Markdown defaults to rendered while other files default to source", () => {
  for (const path of ["index.md", "notes/PLAN.MARKDOWN"]) {
    expect(defaultFileRepresentation(path)).toBe("rendered");
  }
  for (const path of ["index.html", "code.ts", "notes.md.txt"])
    expect(defaultFileRepresentation(path)).toBe("source");
});

test("retired query parameters cannot retarget an explicit publication on reload", () => {
  const search =
    "?version=3&file=notes.md&view=rendered&discussions=discussion_kept&comment=comment_kept";
  const view = readArtifactLocation("files", search);
  expect(view).toEqual({ versionSeq: 3, path: null, representation: "source", threadId: null });
  const next = new URLSearchParams(artifactWorkspaceSearch(view, search));
  expect([...next.keys()]).toEqual(["version"]);
});

test("artifact links select only the publication, while fixed kinds cannot switch representations", () => {
  const location = { versionSeq: 7, path: "notes/a # b?.md", representation: "rendered" as const };
  expect(readArtifactLocation("files", artifactLocationSearch(location))).toEqual({
    versionSeq: 7,
    path: null,
    representation: "source",
    threadId: null,
  });
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

test("version changes clear comparisons and retired parameters but preserve library and language", async () => {
  const { artifactWorkspaceSearch } = await import("./artifact-navigation.ts");
  const view = {
    versionSeq: 2,
    path: "notes.txt",
    representation: "source" as const,
    threadId: null,
  };
  const original =
    "?version=2&file=notes.txt&view=source&thread=old&line=81&side=old&text=quote&summary=1&comment=old&compare=fix&library=%3Fq%3Dkeyboard&lang=zh-CN";
  const retained = new URLSearchParams(artifactWorkspaceSearch(view, original));
  expect([...retained.keys()]).toEqual(["version", "compare", "library", "lang"]);
  expect(retained.get("library")).toBe("?q=keyboard");
  const moved = new URLSearchParams(artifactWorkspaceSearch({ ...view, versionSeq: 3 }, original));
  expect(moved.has("compare")).toBe(false);
  expect(moved.get("lang")).toBe("zh-CN");
  expect(moved.get("library")).toBe("?q=keyboard");
});
