import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Feedback,
  type FeedbackWithReplies,
  hasUnsentContent,
  type ReviewDetail,
} from "../shared/types.ts";
import { buildUnsentPrompt } from "./prompt.ts";

// db.ts opens its singleton at import time. Point it at an isolated store before
// dynamically importing the storage/domain modules so tests never touch the
// user's real r3 state or persisted config.
const testRoot = mkdtempSync(join(tmpdir(), "r3-delivery-test-"));
process.env.R3_DB = join(testRoot, "r3.sqlite");
process.env.XDG_CONFIG_HOME = join(testRoot, "config");

const db = await import("./db.ts");
const reviews = await import("./reviews.ts");

let reviewId = "";

beforeAll(() => {
  const repo = db.registerRepo(join(testRoot, "repo.git"), "delivery-test", null);
  reviewId = db.createReview({
    repoId: repo.id,
    kind: "files",
    source: { ref: "WORKING", files: [] },
    meta: { session: "codex" },
  }).id;
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

function feedback() {
  return db.createFeedback(reviewId, {
    body: "Please address this",
    file: "",
    line_start: null,
    line_end: null,
  });
}

function withReplies(fb: Feedback): FeedbackWithReplies {
  return { ...fb, replies: db.listReplies(fb.id), claim: null };
}

function promptDetail(fb: Feedback): ReviewDetail {
  const review = db.getReview(reviewId);
  if (!review) throw new Error("review missing");
  return {
    ...review,
    working: false,
    feedback: [withReplies(fb)],
    stale: false,
    repoName: "delivery-test",
    branch: null,
    scratchDir: null,
    scratchIgnoredDirs: [],
    patches: [],
    snapshots: [],
  };
}

function mustReply(res: ReturnType<typeof reviews.addReply>) {
  if (!res || reviews.isRejected(res)) throw new Error("reply was not created");
  return res.reply;
}

describe("edited human replies re-enter delivery", () => {
  test("editing a delivered human reply clears sent_at so the new wording is unsent", () => {
    const fb = feedback();
    const reply = mustReply(reviews.addReply(fb.id, { author: "human", body: "Use 3, not 4" }));
    db.markContentSent(reviewId, [fb.id], [reply.id]);
    expect(db.getReply(reply.id)?.sent_at).not.toBeNull();
    expect(hasUnsentContent(withReplies(db.getFeedback(fb.id)!))).toBe(false);

    const edited = reviews.editReply(reply.id, "Use 5, not 4");
    expect(edited?.body).toBe("Use 5, not 4");
    expect(edited?.sent_at).toBeNull();
    expect(db.getReply(reply.id)?.sent_at).toBeNull();

    const next = withReplies(db.getFeedback(fb.id)!);
    expect(hasUnsentContent(next)).toBe(true);

    const prompt = buildUnsentPrompt(promptDetail(db.getFeedback(fb.id)!));
    expect(prompt.included.replies).toEqual([reply.id]);
    expect(prompt.text).toContain("Use 5, not 4");
    expect(prompt.text).not.toContain("Use 3, not 4");
  });

  test("a same-body no-op leaves the delivery stamp on", () => {
    const fb = feedback();
    const reply = mustReply(reviews.addReply(fb.id, { author: "human", body: "Leave this" }));
    db.markContentSent(reviewId, [fb.id], [reply.id]);
    const stamped = db.getReply(reply.id)?.sent_at;
    expect(stamped).not.toBeNull();

    const edited = reviews.editReply(reply.id, "Leave this");
    expect(edited?.sent_at).toBe(stamped);
    expect(hasUnsentContent(withReplies(db.getFeedback(fb.id)!))).toBe(false);
  });

  test("editing an agent reply does not clear sent_at", () => {
    const fb = feedback();
    const reply = mustReply(reviews.addReply(fb.id, { author: "agent", body: "Done" }));
    db.markContentSent(reviewId, [fb.id], [reply.id]);
    const stamped = db.getReply(reply.id)?.sent_at;
    expect(stamped).not.toBeNull();

    const edited = reviews.editReply(reply.id, "Done, with a caveat");
    expect(edited?.body).toBe("Done, with a caveat");
    expect(edited?.sent_at).toBe(stamped);
  });
});
