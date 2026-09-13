import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactConversations } from "./artifact-conversations.ts";
import { createArtifactTables } from "./artifact-schema.ts";
import { ArtifactStore } from "./artifacts.ts";
import { BlobStore } from "./blobs.ts";
import { importLegacyContent } from "./migration-content.ts";
import { importLegacyConversations } from "./migration-conversations.ts";
import { LEGACY_TABLES, type LegacyData, MigrationContext } from "./migration-data.ts";

let root: string;
let db: Database;
let blobs: BlobStore;
let data: LegacyData;
let store: ArtifactStore;
let threads: ArtifactConversations;
const time = "2026-09-01T00:00:00.000Z";
const render = async (source: string) => ({ html: source, revision: "migration-test" });
const patch = "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-old\n+new\n";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-migration-threads-"));
  db = new Database(":memory:");
  createArtifactTables(db);
  blobs = new BlobStore(join(root, "blobs"));
  store = new ArtifactStore(db, blobs, render, () => time);
  threads = new ArtifactConversations(db, store, () => time);
  data = Object.fromEntries(LEGACY_TABLES.map((table) => [table, []])) as unknown as LegacyData;
});
afterEach(async () => {
  db.close();
  await rm(root, { recursive: true, force: true });
});
async function migrate() {
  const context = new MigrationContext(db, data, time);
  await importLegacyContent(context, blobs, render);
  await importLegacyConversations(context, store);
  expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
}

describe("legacy conversation import", () => {
  test("unknown live-file targets retain evidence and distinct agent attribution", async () => {
    data.reviews.push({
      id: "review_files",
      kind: "files",
      status: "open",
      created_by: "agent",
      meta: '{"session":"creator-run"}',
    });
    data.snapshots.push({ review_id: "review_files", seq: 1 });
    data.snapshot_files.push({
      review_id: "review_files",
      seq: 1,
      path: "notes.md",
      content: "# Title",
      sha: "retained-sha",
    });
    data.feedback.push({
      id: "feedback_old",
      review_id: "review_files",
      author: "agent",
      file: "notes.md",
      body: "Keep this thread",
      line_start: 1,
      line_end: 1,
      quote: "Title",
      status: "open",
    });
    data.replies.push({
      id: "reply_old",
      feedback_id: "feedback_old",
      author: "agent",
      body: "Original answer",
      ref_version: 1,
    });
    await migrate();
    const feedback = threads.get("feedback_old");
    expect(feedback.target).toEqual({ kind: "artifact" });
    expect(feedback.legacy).toMatchObject({
      source: { file: "notes.md", quote: "Title", line_start: 1 },
      defaults: expect.arrayContaining([expect.objectContaining({ field: "target" })]),
    });
    expect(feedback.author.role).toBe("agent");
    expect(feedback.author.sessionId).not.toBe("creator-run");
    expect(feedback.replies[0].author.sessionId).not.toBe(feedback.author.sessionId);
    expect(feedback.replies[0].context).toEqual({ versionSeq: 1, representation: null });
    expect(feedback.sentAt).toBe(time);
    expect(feedback.replies[0].sentAt).toBe(time);
    expect(threads.unsent("review_files")).toEqual([]);
  });

  test("explicit diff targets and fix pins retain old/new sides and independent context versions", async () => {
    data.reviews.push({ id: "review_diff", kind: "diff", status: "open", stored_rounds: 1 });
    data.patches.push(
      { review_id: "review_diff", seq: 2, body: patch },
      { review_id: "review_diff", seq: 3, body: patch },
    );
    data.feedback.push({
      id: "feedback_diff",
      review_id: "review_diff",
      author: "human",
      file: "a.txt",
      patch_seq: 2,
      side: "old",
      line_start: 1,
      line_end: 1,
      quote: "old",
      body: "Update this",
      status: "open",
    });
    data.replies.push({
      id: "reply_fix",
      feedback_id: "feedback_diff",
      author: "agent",
      body: "Fixed here",
      patch_seq: 3,
      file: "a.txt",
      line_start: 1,
      line_end: 1,
      ref_version: 2,
    });
    await migrate();
    const feedback = threads.get("feedback_diff");
    expect(feedback.target).toEqual({
      kind: "diff",
      versionSeq: 2,
      path: "a.txt",
      locator: { side: "old", start: 1, end: 1, quote: "old" },
    });
    expect(feedback.replies[0].target).toEqual({
      kind: "diff",
      versionSeq: 3,
      path: "a.txt",
      locator: { side: "new", start: 1, end: 1, quote: "new" },
    });
    expect(feedback.replies[0].context).toEqual({ versionSeq: 2, representation: "diff" });
    expect(feedback.status).toBe("open");
    expect(threads.unsent("review_diff").map((f) => f.id)).toEqual(["feedback_diff"]);
  });

  test("missing rounds remain unavailable and summary/general scopes remain distinct", async () => {
    data.reviews.push({ id: "review_diff", kind: "diff", status: "abandoned", stored_rounds: 1 });
    data.patches.push({ review_id: "review_diff", seq: 3, body: patch });
    data.feedback.push(
      {
        id: "feedback_missing",
        review_id: "review_diff",
        author: "human",
        file: "a.txt",
        patch_seq: 2,
        side: "new",
        line_start: 1,
        line_end: 1,
        quote: "new",
        body: "Original target gone",
        status: "resolved",
        status_unsent: 1,
      },
      { id: "feedback_general", review_id: "review_diff", file: "", body: "General" },
      {
        id: "feedback_summary",
        review_id: "review_diff",
        file: "@summary",
        quote: "Overview",
        body: "Summary",
      },
      {
        id: "feedback_round_summary",
        review_id: "review_diff",
        file: "@summary",
        patch_seq: 3,
        body: "Round summary",
      },
      {
        id: "feedback_missing_summary",
        review_id: "review_diff",
        file: "@summary",
        patch_seq: 2,
        quote: "Missing description",
        body: "Description version gone",
      },
      {
        id: "feedback_null_round",
        review_id: "review_diff",
        file: "a.txt",
        side: "new",
        line_start: 1,
        line_end: 1,
        quote: "new",
        body: "Cannot assume latest",
      },
    );
    data.replies.push({
      id: "reply_missing",
      feedback_id: "feedback_missing",
      author: "human",
      body: "Human follow-up",
      ref_version: 7,
    });
    data.feedback_claims.push({
      feedback_id: "feedback_missing",
      session: "old-run",
      expires_at: "2026-10-01T00:00:00.000Z",
    });
    await migrate();
    const feedback = threads.get("feedback_missing");
    expect(feedback.target).toEqual({ kind: "artifact" });
    expect(feedback.statusUnsent).toBe(true);
    expect(feedback.status).toBe("resolved");
    expect(feedback.claim).toBeNull();
    expect(feedback.legacy).toMatchObject({ expiredClaim: { session: "old-run" } });
    expect(feedback.replies[0].context).toEqual({ versionSeq: null, representation: null });
    expect(feedback.replies[0].legacy).toMatchObject({ source: { ref_version: 7 } });
    expect(feedback.replies[0].sentAt).toBeNull();
    expect(threads.get("feedback_general").target).toEqual({ kind: "artifact" });
    expect(threads.get("feedback_general").author).toEqual({ role: "human", sessionId: null });
    expect(threads.get("feedback_summary").target).toEqual({
      kind: "artifact_summary",
      locator: { quote: "Overview" },
    });
    expect(threads.get("feedback_round_summary").target).toEqual({
      kind: "version_summary",
      versionSeq: 3,
      locator: null,
    });
    expect(threads.get("feedback_missing_summary").target).toEqual({ kind: "artifact" });
    expect(threads.get("feedback_missing_summary").legacy).toMatchObject({
      source: { patch_seq: 2, quote: "Missing description" },
    });
    expect(threads.get("feedback_null_round").target).toEqual({ kind: "artifact" });
    expect(store.get("review_diff").nextSeq).toBe(8);
    expect(store.get("review_diff").updatedAt).toBe(time);
  });
});
