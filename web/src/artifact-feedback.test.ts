import { expect, test } from "bun:test";
import type { ArtifactFeedback, ArtifactReply } from "../../shared/artifacts.ts";
import {
  activeArtifactFeedback,
  artifactNeedsAttention,
  withSavedReply,
} from "./artifact-feedback.ts";
import { artifactFixture, artifactFixtureFeedback } from "./artifact-fixtures.ts";

test("a saved reply preserves concurrent thread changes and newer replies", () => {
  const reply: ArtifactReply = {
    ...artifactFixtureFeedback.replies[0],
    id: "reply_human",
    author: { role: "human", sessionId: null },
    body: "My reply.",
    createdAt: "2026-09-12T12:00:00.000Z",
    sentAt: null,
  };
  const updated = withSavedReply(artifactFixture, reply);
  expect(updated.feedback[0].replies.at(-1)).toEqual(reply);
  expect(updated.unhandledCount).toBe(0);
  expect(artifactFixture.feedback[0].replies).toHaveLength(1);

  const other = { ...artifactFixtureFeedback, id: "feedback_other" };
  const newer = {
    ...artifactFixtureFeedback,
    body: "A concurrent edit.",
    replies: [
      ...artifactFixtureFeedback.replies,
      {
        ...artifactFixtureFeedback.replies[0],
        id: "reply_newer",
        createdAt: "2026-09-13T00:00:00.000Z",
      },
    ],
  };
  const concurrent = withSavedReply({ ...artifactFixture, feedback: [newer, other] }, reply);
  expect(concurrent.feedback[0].body).toBe("A concurrent edit.");
  expect(concurrent.feedback[0].replies.map((item) => item.id)).toEqual([
    "reply_example",
    "reply_human",
    "reply_newer",
  ]);
  expect(concurrent.unhandledCount).toBe(2);
  expect(concurrent.feedback[1]).toBe(other);

  const delivered = { ...reply, body: "A newer edit.", sentAt: "2026-09-13T00:00:00.000Z" };
  const refreshed = { ...updated, feedback: [{ ...updated.feedback[0], replies: [delivered] }] };
  expect(withSavedReply(refreshed, reply)).toBe(refreshed);
  const deleted = { ...artifactFixture, feedback: [], unhandledCount: 0 };
  expect(withSavedReply(deleted, reply)).toBe(deleted);
});

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
