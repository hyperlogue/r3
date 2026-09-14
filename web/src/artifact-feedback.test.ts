import { expect, test } from "bun:test";
import type { ArtifactFeedback } from "../../shared/artifacts.ts";
import { activeArtifactFeedback, artifactNeedsAttention } from "./artifact-feedback.ts";
import { artifactFixtureFeedback } from "./artifact-fixtures.ts";

test("new unsent notes lead the attention queue, followed by waiting and claimed work", () => {
  const base: ArtifactFeedback = {
    ...artifactFixtureFeedback,
    author: { role: "human", sessionId: null },
    replies: [],
    status: "open",
    claim: null,
  };
  const waiting = { ...base, id: "waiting", createdAt: "2026-09-12T00:00:00.000Z" };
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
  const fresh = { ...waiting, id: "fresh", sentAt: null };
  const working = { ...waiting, id: "working", claim: claimed.claim };
  expect(
    activeArtifactFeedback([waiting, claimed, done, attention, fresh, working]).map(
      (note) => note.id,
    ),
  ).toEqual(["fresh", "attention", "claimed", "waiting", "working"]);
  expect(
    artifactNeedsAttention({
      ...attention,
      replies: [
        { ...artifactFixtureFeedback.replies[0], author: { role: "human", sessionId: null } },
      ],
    }),
  ).toBe(false);
});

test("a human reply moves a handled thread behind the next thread needing attention", () => {
  const older = { ...artifactFixtureFeedback, id: "older" };
  const newer = {
    ...artifactFixtureFeedback,
    id: "newer",
    createdAt: "2026-09-12T00:00:00.000Z",
  };
  expect(activeArtifactFeedback([older, newer]).map((note) => note.id)).toEqual(["newer", "older"]);
  const handled: ArtifactFeedback = {
    ...newer,
    replies: [
      ...newer.replies,
      {
        ...newer.replies[0],
        id: "human-followup",
        author: { role: "human", sessionId: null },
        sentAt: null,
      },
    ],
  };
  expect(activeArtifactFeedback([older, handled]).map((note) => note.id)).toEqual([
    "older",
    "newer",
  ]);
  // A later agent response needs attention again, regardless of its delivery stamp.
  const answered = { ...handled, replies: [...handled.replies, newer.replies[0]] };
  expect(activeArtifactFeedback([older, answered]).map((note) => note.id)).toEqual([
    "newer",
    "older",
  ]);
});

test("equal timestamps retain reverse publication order without mutating the input", () => {
  const notes = ["z", "a", "b"].map((id) => ({ ...artifactFixtureFeedback, id }));
  expect(activeArtifactFeedback(notes).map((note) => note.id)).toEqual(["b", "a", "z"]);
  expect(notes.map((note) => note.id)).toEqual(["z", "a", "b"]);
});
