import { expect, test } from "bun:test";
import type { ArtifactDetail, ArtifactTarget } from "../../shared/artifacts.ts";
import { artifactComparisons } from "./artifact-comparison.ts";
import { artifactFixture, artifactFixtureDiscussion } from "./artifact-fixtures.ts";

const original = {
  kind: "rendered",
  versionSeq: 1,
  path: "index.html",
  locator: { selector: "#old", route: "#settings" },
} as const;
const proposed = { ...original, versionSeq: 2, locator: { selector: "#new", route: "#workspace" } };
function fixture(): ArtifactDetail {
  return {
    ...artifactFixture,
    versions: [artifactFixture.versions[0], { ...artifactFixture.versions[0], seq: 2 }],
    discussions: [
      {
        ...artifactFixtureDiscussion,
        target: original,
        comments: [
          {
            ...artifactFixtureDiscussion.comments[0]!,
          },
          {
            ...artifactFixtureDiscussion.comments.slice(1)[0],
            context: { versionSeq: 1, representation: "source" },
            target: proposed,
          },
        ],
      },
    ],
  };
}
test("comparison uses the immutable original and explicit fix independently of comment context or latest version", () => {
  const detail = fixture();
  detail.placements = [
    {
      artifactId: detail.id,
      discussionId: detail.discussions[0].id,
      target: proposed,
      state: "anchored",
      createdAt: detail.createdAt,
      updatedAt: detail.updatedAt,
    },
  ];
  const pair = [...artifactComparisons(detail).values()][0];
  expect(pair.original).toEqual(original);
  expect(pair.proposed).toEqual(proposed);
  detail.discussions[0].status = "resolved";
  detail.state = "archived";
  expect(artifactComparisons(detail).size).toBe(1);
  detail.discussions[0].comments.push({
    ...detail.discussions[0].comments.slice(1)[0],
    id: "another-fix",
    target: original,
  });
  expect(artifactComparisons(detail).size).toBe(2);
});
test("comparison excludes general, whole-document, source, unknown and missing-publication targets", () => {
  const invalid: ArtifactTarget[] = [
    { kind: "artifact" },
    { ...original, locator: null },
    { ...original, locator: { selector: " " } },
    { ...original, versionSeq: 9 },
    {
      kind: "source",
      versionSeq: 1,
      path: "index.html",
      locator: { start: 1, end: 2, quote: "example" },
    },
    { kind: "version_summary", versionSeq: 1, locator: null },
  ];
  for (const target of invalid) {
    const detail = fixture();
    detail.discussions[0].target = target;
    expect(artifactComparisons(detail).size).toBe(0);
    if (target.kind === "artifact" || target.kind === "artifact_summary") continue;
    detail.discussions[0].target = original;
    detail.discussions[0].comments.slice(1)[0].target = target;
    expect(artifactComparisons(detail).size).toBe(0);
  }
  const detail = fixture();
  detail.discussions[0].comments.slice(1)[0].target = null;
  expect(artifactComparisons(detail).size).toBe(0);
  detail.discussions[0].comments.slice(1)[0].target = proposed;
  detail.discussions[0].comments.slice(1)[0].author = { role: "human", sessionId: null };
  expect(artifactComparisons(detail).size).toBe(0);
});
test("media Compare requires saved original and agent fix frames with independent times", () => {
  const detail = fixture();
  const frame = {
    id: "image_frame",
    artifactId: detail.id,
    hash: "f".repeat(64),
    mediaType: "image/png" as const,
    byteLength: 100,
    width: 640,
    height: 360,
  };
  const media = {
    kind: "media" as const,
    versionSeq: 1,
    path: "clip.mp4",
    locator: { time: 4.8123456, box: { x: 0, y: 0, width: 1, height: 1 }, frame },
  };
  detail.discussions[0].target = media;
  detail.discussions[0].comments.slice(1)[0].target = {
    ...media,
    versionSeq: 2,
    locator: { ...media.locator, time: 6.3 },
  };
  const comparison = [...artifactComparisons(detail).values()][0]!;
  expect(comparison.original).toEqual(media);
  expect(comparison.proposed).toMatchObject(detail.discussions[0].comments[1].target!);
  detail.discussions[0].comments.slice(1)[0].author = { role: "human", sessionId: null };
  expect(artifactComparisons(detail).size).toBe(0);
  detail.discussions[0].comments.slice(1)[0].author = { role: "agent", sessionId: "design-agent" };
  detail.discussions[0].target = { ...media, locator: { ...media.locator, frame: undefined } };
  expect(artifactComparisons(detail).size).toBe(0);
});
