import { expect, test } from "bun:test";
import { ARTIFACT_WORKSHOP_SEED } from "./artifact-fixtures.gen.ts";
import type { ArtifactDemoState } from "./artifact-model.ts";
import { searchDemoArtifacts } from "./artifact-search.ts";

test("demo search uses immutable publications and current conversations", () => {
  const state: ArtifactDemoState = {
    ...structuredClone(ARTIFACT_WORKSHOP_SEED),
    schema: 4,
    viewed: {},
    feedbackRevisions: {},
    everDelivered: {},
  };
  const artifact = state.artifacts[0];
  const feedback = artifact.feedback[0];
  feedback.body = "Distinctive search wording";
  const found = searchDemoArtifacts(state, { q: "Distinctive", type: "conversation" });
  expect(found.matches).toHaveLength(1);
  expect(found.matches[0].feedbackId).toBe(feedback.id);
  expect(found.matches[0].versionSeq).toBe(
    "versionSeq" in feedback.target ? feedback.target.versionSeq : null,
  );
  feedback.body = "Changed after review";
  expect(searchDemoArtifacts(state, { q: "Distinctive" }).total).toBe(0);
  const title = searchDemoArtifacts(state, { q: artifact.title! });
  expect(
    title.matches.some(
      (match) => match.category === "artifact" && match.artifactId === artifact.id,
    ),
  ).toBe(true);
});
