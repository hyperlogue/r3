import { expect, test } from "bun:test";
import type { ArtifactComment, ArtifactDiscussion } from "../../shared/artifacts.ts";
import {
  activeArtifactDiscussion,
  artifactNeedsAttention,
  withSavedComment,
} from "./artifact-discussions.ts";
import { artifactFixture, artifactFixtureDiscussion } from "./artifact-fixtures.ts";

test("a saved comment preserves concurrent thread changes and newer comments", () => {
  const comment: ArtifactComment = {
    ...artifactFixtureDiscussion.comments[0],
    id: "comment_human",
    author: { role: "human", sessionId: null },
    body: "My comment.",
    createdAt: "2026-09-12T12:00:00.000Z",
    sentAt: null,
  };
  const updated = withSavedComment(artifactFixture, comment);
  expect(updated.discussions[0].comments.at(-1)).toEqual(comment);
  expect(updated.unhandledCount).toBe(0);
  expect(artifactFixture.discussions[0].comments).toHaveLength(1);

  const other = { ...artifactFixtureDiscussion, id: "discussion_other" };
  const newer = {
    ...artifactFixtureDiscussion,
    body: "A concurrent edit.",
    comments: [
      ...artifactFixtureDiscussion.comments,
      {
        ...artifactFixtureDiscussion.comments[0],
        id: "comment_newer",
        createdAt: "2026-09-13T00:00:00.000Z",
      },
    ],
  };
  const concurrent = withSavedComment({ ...artifactFixture, discussions: [newer, other] }, comment);
  expect(concurrent.discussions[0].body).toBe("A concurrent edit.");
  expect(concurrent.discussions[0].comments.map((item) => item.id)).toEqual([
    "comment_example",
    "comment_human",
    "comment_newer",
  ]);
  expect(concurrent.unhandledCount).toBe(2);
  expect(concurrent.discussions[1]).toBe(other);

  const delivered = { ...comment, body: "A newer edit.", sentAt: "2026-09-13T00:00:00.000Z" };
  const refreshed = {
    ...updated,
    discussions: [{ ...updated.discussions[0], comments: [delivered] }],
  };
  expect(withSavedComment(refreshed, comment)).toBe(refreshed);
  const deleted = { ...artifactFixture, discussions: [], unhandledCount: 0 };
  expect(withSavedComment(deleted, comment)).toBe(deleted);
});

test("new unsent notes lead the attention queue, followed by waiting and claimed work", () => {
  const base: ArtifactDiscussion = {
    ...artifactFixtureDiscussion,
    author: { role: "human", sessionId: null },
    comments: [],
    status: "open",
    claim: null,
  };
  const waiting = { ...base, id: "waiting", createdAt: "2026-09-12T00:00:00.000Z" };
  const attention: ArtifactDiscussion = {
    ...base,
    id: "attention",
    author: { role: "agent", sessionId: "agent-example" },
  };
  const claimed = {
    ...attention,
    id: "claimed",
    claim: {
      discussionId: "claimed",
      sessionId: "agent-example",
      claimedAt: "2026-09-12T00:00:00Z",
      renewedAt: "2026-09-12T00:00:00Z",
      expiresAt: "2026-09-12T01:00:00Z",
    },
  };
  const done: ArtifactDiscussion = { ...attention, id: "done", status: "resolved" };
  const fresh = { ...waiting, id: "fresh", sentAt: null };
  const working = { ...waiting, id: "working", claim: claimed.claim };
  expect(
    activeArtifactDiscussion([waiting, claimed, done, attention, fresh, working]).map(
      (note) => note.id,
    ),
  ).toEqual(["fresh", "attention", "claimed", "waiting", "working"]);
  expect(
    artifactNeedsAttention({
      ...attention,
      comments: [
        { ...artifactFixtureDiscussion.comments[0], author: { role: "human", sessionId: null } },
      ],
    }),
  ).toBe(false);
});

test("a human comment moves a handled thread behind the next thread needing attention", () => {
  const older = { ...artifactFixtureDiscussion, id: "older" };
  const newer = {
    ...artifactFixtureDiscussion,
    id: "newer",
    createdAt: "2026-09-12T00:00:00.000Z",
  };
  expect(activeArtifactDiscussion([older, newer]).map((note) => note.id)).toEqual([
    "newer",
    "older",
  ]);
  const handled: ArtifactDiscussion = {
    ...newer,
    comments: [
      ...newer.comments,
      {
        ...newer.comments[0],
        id: "human-followup",
        author: { role: "human", sessionId: null },
        sentAt: null,
      },
    ],
  };
  expect(activeArtifactDiscussion([older, handled]).map((note) => note.id)).toEqual([
    "older",
    "newer",
  ]);
  // A later agent response needs attention again, regardless of its delivery stamp.
  const answered = { ...handled, comments: [...handled.comments, newer.comments[0]] };
  expect(activeArtifactDiscussion([older, answered]).map((note) => note.id)).toEqual([
    "newer",
    "older",
  ]);
});

test("equal timestamps retain reverse publication order without mutating the input", () => {
  const notes = ["z", "a", "b"].map((id) => ({ ...artifactFixtureDiscussion, id }));
  expect(activeArtifactDiscussion(notes).map((note) => note.id)).toEqual(["b", "a", "z"]);
  expect(notes.map((note) => note.id)).toEqual(["z", "a", "b"]);
});
