import { expect, test } from "bun:test";
import type { ArtifactFeedback } from "../../shared/artifacts.ts";
import { activeArtifactFeedback, artifactNeedsAttention } from "./artifact-feedback.ts";
import { artifactFixtureFeedback } from "./artifact-fixtures.ts";

test("the active queue puts human decisions first and claimed work last", () => {
  const base: ArtifactFeedback = {
    ...artifactFixtureFeedback,
    author: { role: "human", sessionId: null },
    replies: [],
    status: "open",
    claim: null,
  };
  const waiting = { ...base, id: "waiting" };
  const attention: ArtifactFeedback = {
    ...base,
    id: "attention",
    author: { role: "agent", sessionId: "agent-example" },
  };
  const claimed = {
    ...attention,
    id: "claimed",
    claim: {
      feedbackId: "claimed",
      sessionId: "agent-example",
      claimedAt: "2026-09-12T00:00:00Z",
      renewedAt: "2026-09-12T00:00:00Z",
      expiresAt: "2026-09-12T01:00:00Z",
    },
  };
  const done: ArtifactFeedback = { ...attention, id: "done", status: "resolved" };
  expect(
    activeArtifactFeedback([waiting, claimed, done, attention]).map((note) => note.id),
  ).toEqual(["attention", "waiting", "claimed"]);
  expect(
    artifactNeedsAttention({
      ...attention,
      replies: [
        { ...artifactFixtureFeedback.replies[0], author: { role: "human", sessionId: null } },
      ],
    }),
  ).toBe(false);
});
