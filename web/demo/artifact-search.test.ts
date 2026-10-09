import { expect, test } from "bun:test";
import { ARTIFACT_WORKSHOP_SEED } from "./artifact-fixtures.gen.ts";
import type { ArtifactDemoState } from "./artifact-model.ts";
import { searchDemoArtifacts } from "./artifact-search.ts";

test("demo search uses immutable publications and current conversations", () => {
  const state: ArtifactDemoState = {
    ...structuredClone(ARTIFACT_WORKSHOP_SEED),
    viewed: {},
    discussionRevisions: {},
    everDelivered: {},
  };
  const artifact = state.artifacts[0];
  const discussions = artifact.discussions[0];
  discussions.comments[0]!.body = "Distinctive search wording";
  const found = searchDemoArtifacts(state, { q: "Distinctive", type: "conversation" });
  expect(found.matches).toHaveLength(1);
  expect(found.matches[0].discussionId).toBe(discussions.id);
  expect(found.matches[0].versionSeq).toBe(
    "versionSeq" in discussions.target ? discussions.target.versionSeq : null,
  );
  discussions.comments[0]!.body = "Changed after review";
  expect(searchDemoArtifacts(state, { q: "Distinctive" }).total).toBe(0);
  const title = searchDemoArtifacts(state, { q: artifact.title! });
  expect(
    title.matches.some(
      (match) => match.category === "artifact" && match.artifactId === artifact.id,
    ),
  ).toBe(true);
});
