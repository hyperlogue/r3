import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// db.ts opens its singleton at import time. Point it at an isolated store before
// dynamically importing the storage module so tests never touch the user's real
// r3 state or persisted config.
const testRoot = mkdtempSync(join(tmpdir(), "r3-seq-test-"));
process.env.R3_DB = join(testRoot, "r3.sqlite");
process.env.XDG_CONFIG_HOME = join(testRoot, "config");

const db = await import("./db.ts");

let repoId = "";

beforeAll(() => {
  repoId = db.registerRepo(join(testRoot, "repo.git"), "seq-test", null).id;
});

afterAll(() => {
  rmSync(testRoot, { recursive: true, force: true });
});

describe("seq allocation after rm", () => {
  test("addPatch does not reuse a seq still stored as replies.ref_version", () => {
    const reviewId = db.createReview({
      repoId,
      kind: "diff",
      source: { base: "HEAD", head: "WORKING" },
    }).id;
    const first = db.addPatch(reviewId, "diff --git a/a b/a\n", "r1");
    expect(first.seq).toBe(1);

    const fb = db.createFeedback(reviewId, {
      body: "Please address this",
      file: "",
      line_start: null,
      line_end: null,
    });
    db.createReply(fb.id, { body: "See @a.ts:L1", ref_version: 1, patch_seq: null });

    expect(db.deletePatch(reviewId, 1)).toBe(true);
    const next = db.addPatch(reviewId, "diff --git a/a b/a\n", "r2");
    expect(next.seq).toBe(2);
  });

  test("addSnapshot does not reuse a seq still stored as replies.ref_version", () => {
    const reviewId = db.createReview({
      repoId,
      kind: "files",
      source: { ref: "WORKING", files: [] },
    }).id;
    const first = db.addSnapshot(reviewId, [{ path: "a.txt", content: "hello", sha: "abc" }], "s1");
    expect(first.seq).toBe(1);

    const fb = db.createFeedback(reviewId, {
      body: "Please address this",
      file: "",
      line_start: null,
      line_end: null,
    });
    db.createReply(fb.id, { body: "See @a.txt:L1", ref_version: 1, patch_seq: null });

    expect(db.deleteSnapshot(reviewId, 1)).toBe(true);
    const next = db.addSnapshot(reviewId, [{ path: "a.txt", content: "hello", sha: "abc" }], "s2");
    expect(next.seq).toBe(2);
  });

  test("hadStoredRounds stays true after the last patch is removed", () => {
    const reviewId = db.createReview({
      repoId,
      kind: "diff",
      source: { base: "HEAD", head: "WORKING" },
    }).id;
    expect(db.hadStoredRounds(reviewId)).toBe(false);
    db.addPatch(reviewId, "diff --git a/a b/a\n", "r1");
    expect(db.hadStoredRounds(reviewId)).toBe(true);
    expect(db.deletePatch(reviewId, 1)).toBe(true);
    expect(db.hasPatches(reviewId)).toBe(false);
    expect(db.hadStoredRounds(reviewId)).toBe(true);
  });
});
