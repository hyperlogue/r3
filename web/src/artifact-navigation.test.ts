import { expect, test } from "bun:test";
import type { ArtifactTarget } from "../../shared/artifacts.ts";
import { artifactFixture, artifactFixtureFeedback } from "./artifact-fixtures.ts";
import {
  artifactLocationSearch,
  artifactRegions,
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

test("artifact links retain native view and unusual path characters, while fixed kinds cannot switch representations", () => {
  const location = { versionSeq: 7, path: "notes/a # b?.md", representation: "rendered" as const };
  expect(
    readArtifactLocation("files", artifactLocationSearch(location, "feedback_example")),
  ).toEqual({ ...location, feedbackId: "feedback_example" });
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
        feedbackId: artifactFixtureFeedback.id,
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
      id: artifactFixtureFeedback.id,
      file: "index.md",
      start: 4,
      end: 4,
      side: "new",
      quote: "comparison",
    },
  ]);
  expect(artifactRegions(placed, 1, "source")).toEqual([]);
  expect(visibleArtifactTargets(placed, 1, "rendered")[0].target as ArtifactTarget).toBe(
    artifactFixtureFeedback.target,
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
