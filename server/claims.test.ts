import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// db.ts opens its singleton at import time. Point it at an isolated store before
// dynamically importing the storage/domain modules so tests never touch the
// user's real r3 state or persisted config.
const testRoot = mkdtempSync(join(tmpdir(), "r3-claims-test-"));
process.env.R3_DB = join(testRoot, "r3.sqlite");
process.env.XDG_CONFIG_HOME = join(testRoot, "config");

const db = await import("./db.ts");
const reviews = await import("./reviews.ts");

let reviewId = "";

beforeAll(() => {
  const repo = db.registerRepo(join(testRoot, "repo.git"), "claims-test", null);
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

describe("feedback work claims", () => {
  test("claim defaults the session, renews for the same owner, and rejects another", () => {
    const fb = feedback();
    const first = reviews.claimFeedback(fb.id, {});
    expect(reviews.isRejected(first)).toBe(false);
    expect(first).toMatchObject({ feedback_id: fb.id, session: "codex" });
    expect(db.reviewIdsWithFeedbackClaims().has(reviewId)).toBe(true);

    const renewed = reviews.claimFeedback(fb.id, { session: "codex", agentId: "agent_1" });
    expect(reviews.isRejected(renewed)).toBe(false);
    if (!renewed || reviews.isRejected(renewed)) throw new Error("claim did not renew");
    if (!first || reviews.isRejected(first)) throw new Error("claim was not created");
    expect(renewed.claimed_at).toBe(first.claimed_at);
    expect(renewed.agentId).toBe("agent_1");

    const conflict = reviews.claimFeedback(fb.id, { session: "other", agentId: "agent_2" });
    expect(conflict).toMatchObject({ status: 409 });
    expect(db.getFeedbackClaim(fb.id)?.agentId).toBe("agent_1");
  });

  test("only a successful agent reply releases the claim", () => {
    const fb = feedback();
    const claim = reviews.claimFeedback(fb.id, { session: "codex" });
    expect(reviews.isRejected(claim)).toBe(false);

    const human = reviews.addReply(fb.id, { author: "human", body: "One more detail" });
    expect(reviews.isRejected(human)).toBe(false);
    expect(db.getFeedbackClaim(fb.id)).not.toBeNull();

    const agent = reviews.addReply(fb.id, { author: "agent", body: "Handled" });
    expect(reviews.isRejected(agent)).toBe(false);
    expect(db.getFeedbackClaim(fb.id)).toBeNull();
  });

  test("resolving feedback and closing a review clear claims", () => {
    const first = feedback();
    reviews.claimFeedback(first.id, { session: "codex" });
    reviews.editFeedback(first.id, { status: "resolved" });
    expect(db.getFeedbackClaim(first.id)).toBeNull();

    const second = feedback();
    reviews.claimFeedback(second.id, { session: "codex" });
    db.updateReview(reviewId, { status: "approved" });
    expect(db.getFeedbackClaim(second.id)).toBeNull();
  });
});
