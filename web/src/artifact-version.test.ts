import { expect, test } from "bun:test";
import type { ArtifactVersion } from "../../shared/artifacts.ts";
import {
  artifactViewForTarget,
  selectedArtifactVersion,
  stepArtifactVersion,
} from "./artifact-version.ts";

const versions = [1, 3, 4].map((seq) => ({ seq })) as ArtifactVersion[];
test("version selection follows actual publications and never substitutes a missing historical target", () => {
  expect(selectedArtifactVersion(versions, null)?.seq).toBe(4);
  expect(selectedArtifactVersion(versions, 1)?.seq).toBe(1);
  expect(selectedArtifactVersion(versions, 2)).toBeNull();
  expect(stepArtifactVersion(versions, 1, 1)).toBe(3);
  expect(stepArtifactVersion(versions, 4, 1)).toBe(4);
  expect(stepArtifactVersion([], null, 1)).toBeNull();
});
test("locating a target restores its native representation and version", () => {
  const source = { versionSeq: 4, path: "index.md", representation: "source" as const };
  expect(
    artifactViewForTarget(
      "files",
      {
        kind: "rendered",
        path: "index.md",
        versionSeq: 1,
        locator: { selector: "a", quote: "Link label" },
      },
      source,
    ),
  ).toEqual({ versionSeq: 1, path: "index.md", representation: "rendered" });
  expect(
    artifactViewForTarget(
      "files",
      { kind: "source", path: "index.md", versionSeq: 3, locator: null },
      { ...source, representation: "rendered" },
    ),
  ).toEqual({ ...source, versionSeq: 3 });
  expect(artifactViewForTarget("files", { kind: "artifact" }, source)).toBe(source);
});
