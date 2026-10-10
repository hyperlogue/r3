import { expect, test } from "bun:test";
import type { ArtifactComment, ArtifactThread } from "../../shared/artifacts.ts";
import { artifactFixture, artifactFixtureThread } from "./artifact-fixtures.ts";
import {
  activeArtifactThreads,
  artifactNeedsAttention,
  withSavedComment,
} from "./artifact-threads.ts";

test("a saved comment preserves concurrent thread changes and newer comments", () => {
  const comment: ArtifactComment = {
    ...artifactFixtureThread.comments.slice(1)[0],
    id: "comment_human",
    author: { role: "human", sessionId: null },
    body: "My comment.",
    createdAt: "2026-09-12T12:00:00.000Z",
    sentAt: null,
  };
  const updated = withSavedComment(artifactFixture, comment);
  expect(updated.threads[0].comments.slice(1).at(-1)).toEqual(comment);
  expect(updated.unhandledCount).toBe(0);
  expect(artifactFixture.threads[0].comments.slice(1)).toHaveLength(1);
  const other = { ...artifactFixtureThread, id: "thread_other" };
  const newer = {
    ...artifactFixtureThread,
    comments: [
      {
        ...artifactFixtureThread.comments[0]!,
        body: "A concurrent edit.",
      },
      ...artifactFixtureThread.comments.slice(1),
      {
        ...artifactFixtureThread.comments.slice(1)[0],
        id: "comment_newer",
        createdAt: "2026-09-13T00:00:00.000Z",
      },
    ],
  };
  const concurrent = withSavedComment({ ...artifactFixture, threads: [newer, other] }, comment);
  expect(concurrent.threads[0].comments[0]!.body).toBe("A concurrent edit.");
  expect(concurrent.threads[0].comments.slice(1).map((item) => item.id)).toEqual([
    "comment_example",
    "comment_human",
    "comment_newer",
  ]);
  expect(concurrent.unhandledCount).toBe(2);
  expect(concurrent.threads[1]).toBe(other);
  const delivered = { ...comment, body: "A newer edit.", sentAt: "2026-09-13T00:00:00.000Z" };
  const refreshed = {
    ...updated,
    threads: [
      {
        ...updated.threads[0],
        comments: [
          {
            ...updated.threads[0].comments[0]!,
          },
          delivered,
        ],
      },
    ],
  };
  expect(withSavedComment(refreshed, comment)).toBe(refreshed);
  const deleted = { ...artifactFixture, threads: [], unhandledCount: 0 };
  expect(withSavedComment(deleted, comment)).toBe(deleted);
});
test("new unsent notes lead the attention queue, followed by waiting and claimed work", () => {
  const base: ArtifactThread = {
    ...artifactFixtureThread,
    status: "open",
    claim: null,
    comments: [
      {
        ...artifactFixtureThread.comments[0]!,
        author: { role: "human", sessionId: null },
      },
    ],
  };
  const waiting = { ...base, id: "waiting", createdAt: "2026-09-12T00:00:00.000Z" };
  const attention: ArtifactThread = {
    ...base,
    id: "attention",
    comments: [
      {
        ...base.comments[0]!,
        author: { role: "agent", sessionId: "agent-example" },
      },
      ...base.comments.slice(1),
    ],
  };
  const claimed = {
    ...attention,
    id: "claimed",
    claim: {
      threadId: "claimed",
      sessionId: "agent-example",
      claimedAt: "2026-09-12T00:00:00Z",
      renewedAt: "2026-09-12T00:00:00Z",
      expiresAt: "2026-09-12T01:00:00Z",
    },
  };
  const done: ArtifactThread = { ...attention, id: "done", status: "resolved" };
  const fresh = {
    ...waiting,
    id: "fresh",
    comments: [
      {
        ...waiting.comments[0]!,
        sentAt: null,
      },
      ...waiting.comments.slice(1),
    ],
  };
  const working = { ...waiting, id: "working", claim: claimed.claim };
  expect(
    activeArtifactThreads([waiting, claimed, done, attention, fresh, working]).map(
      (note) => note.id,
    ),
  ).toEqual(["fresh", "attention", "claimed", "waiting", "working"]);
  expect(
    artifactNeedsAttention({
      ...attention,
      comments: [
        {
          ...attention.comments[0]!,
        },
        {
          ...artifactFixtureThread.comments.slice(1)[0],
          author: { role: "human", sessionId: null },
        },
      ],
    }),
  ).toBe(false);
});
test("a human comment moves a handled thread behind the next thread needing attention", () => {
  const older = { ...artifactFixtureThread, id: "older" };
  const newer = {
    ...artifactFixtureThread,
    id: "newer",
    createdAt: "2026-09-12T00:00:00.000Z",
  };
  expect(activeArtifactThreads([older, newer]).map((note) => note.id)).toEqual(["newer", "older"]);
  const handled: ArtifactThread = {
    ...newer,
    comments: [
      {
        ...newer.comments[0]!,
      },
      ...newer.comments.slice(1),
      {
        ...newer.comments.slice(1)[0],
        id: "human-followup",
        author: { role: "human", sessionId: null },
        sentAt: null,
      },
    ],
  };
  expect(activeArtifactThreads([older, handled]).map((note) => note.id)).toEqual([
    "older",
    "newer",
  ]);
  // A later agent response needs attention again, regardless of its delivery stamp.
  const answered = {
    ...handled,
    comments: [
      {
        ...handled.comments[0]!,
      },
      ...handled.comments.slice(1),
      newer.comments.slice(1)[0],
    ],
  };
  expect(activeArtifactThreads([older, answered]).map((note) => note.id)).toEqual([
    "newer",
    "older",
  ]);
});
test("equal timestamps retain reverse publication order without mutating the input", () => {
  const notes = ["z", "a", "b"].map((id) => ({ ...artifactFixtureThread, id }));
  expect(activeArtifactThreads(notes).map((note) => note.id)).toEqual(["b", "a", "z"]);
  expect(notes.map((note) => note.id)).toEqual(["z", "a", "b"]);
});
