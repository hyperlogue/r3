// Domain rules over the storage layer: building a review's full detail with
// live re-anchoring, applying a reply's action to its parent feedback's status,
// and explicit agent re-anchoring. Storage stays in db.ts;
// this module owns the rules and the SSE side effects.

import type {
  AddReplyBody,
  CreateFeedbackBody,
  Creator,
  Feedback,
  FeedbackWithReplies,
  Reply,
  Review,
  ReviewDetail,
  SnapshotMeta,
} from "../shared/types.ts";
import { SUMMARY_FILE } from "../shared/types.ts";
import { findQuote, type ProjectedDoc, projectDoc } from "./anchor.ts";
import * as db from "./db.ts";
import { forget, markAnchored, markDirty, needsReanchor } from "./dirty.ts";
import { blobSha, readContentAt, snapshotDiff } from "./git.ts";
import { newReviewId } from "./ids.ts";
import { MAX_PATCH_BYTES, parsePatch, validateReplyPin } from "./patches.ts";
import { buildUnsentPrompt } from "./prompt.ts";
import { isImmutableSource, type Repo, resolveRepoForReview } from "./repo.ts";
import {
  createScratchDir,
  deleteScratch,
  isScratchReview,
  removeScratchDir,
  scratchFiles,
  scratchIgnoredDirs,
  scratchReviewDir,
} from "./scratch.ts";
import { captureSnapshot } from "./snapshots.ts";
import { broadcast } from "./sse.ts";

// A domain-level rejection the route layer turns into a 400 (vs null = 404).
export interface Rejected {
  error: string;
}
export const isRejected = (v: unknown): v is Rejected =>
  !!v && typeof v === "object" && "error" in v;

// Re-search each feedback's quote in the current file (within the review's
// worktree) and relocate it; mark `outdated` when the quote is gone. Returns
// true if anything changed. Only files reviews — a diff review's content is its
// stored rounds, which are immutable, so its anchors can never drift.
export async function reanchorReview(repo: Repo, review: Review): Promise<boolean> {
  if (review.kind !== "files" || isImmutableSource(review.source)) return false;
  // Scratch content lives in the data dir, so a stale worktree doesn't block it;
  // for worktree-backed reviews a stale tree has nothing to re-read.
  if (repo.stale && !isScratchReview(review)) return false;
  const src = review.source as { ref: string; files: string[] };
  let changed = false;
  // Many feedback typically share one file, so read + project each file at most
  // once per pass (undefined = not yet loaded, null = file absent) instead of
  // re-reading and re-scanning it per feedback.
  const docs = new Map<string, ProjectedDoc | null>();
  for (const fb of db.listFeedback(review.id)) {
    if (!fb.quote) continue;
    // Summary feedback anchors to prose in the review/round summary, not a
    // worktree file — there's nothing to re-read, so leave it as-is.
    if (fb.file === SUMMARY_FILE) continue;
    let doc = docs.get(fb.file);
    if (doc === undefined) {
      const content = await readContentAt(repo, fb.file, src.ref);
      doc = content == null ? null : projectDoc(content);
      docs.set(fb.file, doc);
    }
    if (doc == null) {
      if (fb.anchor !== "outdated") {
        db.updateFeedback(fb.id, { anchor: "outdated" });
        changed = true;
      }
      continue;
    }
    const match = findQuote(doc, fb.quote, fb.line_start);
    if (!match) {
      if (fb.anchor !== "outdated") {
        db.updateFeedback(fb.id, { anchor: "outdated" });
        changed = true;
      }
      continue;
    }
    const sha = await blobSha(match.text);
    const moved =
      fb.line_start !== match.lineStart ||
      fb.line_end !== match.lineEnd ||
      fb.anchor !== "anchored";
    if (moved) {
      db.updateFeedback(fb.id, {
        line_start: match.lineStart,
        line_end: match.lineEnd,
        code_sha: sha,
        anchor: "anchored",
      });
      changed = true;
    }
  }
  return changed;
}

export async function buildReviewDetail(id: string): Promise<ReviewDetail | null> {
  const review = db.getReview(id);
  if (!review) return null;
  // Resolve the review's repo/worktree (id-addressed — no client hint needed),
  // re-anchor against the live tree, and surface staleness for the UI.
  const repo = await resolveRepoForReview(review);
  const scratch = isScratchReview(review);
  // Re-anchor against live content: the worktree for file/diff reviews, the
  // scratch dir for scratch docs (available even when the worktree is stale). Only
  // when the review is dirty (content changed since the last pass) or not yet
  // anchored this lifetime — an incidental refetch (a reply, a status flip) skips
  // the file reads + quote searches entirely (see dirty.ts).
  // Clear the dirty flag BEFORE the awaited re-anchor pass, not after. The
  // fs-watch callback calls markDirty(id) synchronously; if a file is edited
  // *during* this pass (while we await the per-file reads), marking anchored
  // afterwards would erase that fresh dirty bit and leave the new edit
  // un-re-anchored until some unrelated change. Ordering markAnchored first
  // means a mid-pass markDirty re-sets dirty and the *next* build re-anchors —
  // we'd rather re-anchor once too often than miss an edit (dirty.ts semantics:
  // markAnchored = dirty.delete + anchoredOnce.add; needsReanchor = dirty.has ||
  // !anchoredOnce.has).
  if (repo && (scratch || !repo.stale) && needsReanchor(id)) {
    markAnchored(id);
    await reanchorReview(repo, review);
  }
  const feedback: FeedbackWithReplies[] = db.listFeedback(id).map((fb) => ({
    ...fb,
    replies: db.listReplies(fb.id),
  }));
  // A scratch review's file list is derived live from its directory (the agent
  // adds/removes files there), so refresh source.files from the current scan.
  const source = scratch ? { ...review.source, files: scratchFiles(review) } : review.source;
  const patches = review.kind === "diff" ? db.listPatchMetas(id) : [];
  // Files reviews carry content snapshots; the from/to picker diffs
  // any two. Note snapshots don't make a files review non-stale: the default view
  // is the *live* worktree, which a moved/missing tree still takes away.
  const snapshots = review.kind === "files" ? db.listSnapshotMetas(id) : [];
  return {
    ...review,
    source,
    feedback,
    // Daemon-owned content never goes stale: scratch docs live in the data dir,
    // and a diff review with stored rounds renders from the patches table — a
    // moved/missing worktree can't take either away.
    stale: scratch || patches.length > 0 ? false : !repo || repo.stale,
    repoName: repo?.name ?? null,
    branch: review.worktree?.branch ?? null,
    scratchDir: scratch ? scratchReviewDir(review.id) : null,
    scratchIgnoredDirs: scratch ? scratchIgnoredDirs(review) : [],
    patches,
    snapshots,
  };
}

// Build the unsent-only prompt for a review and mark exactly the rendered
// feedback/replies as delivered to the agent. Marking bumps the
// review's updated_at and pushes `review-updated`, so the open UI recomputes
// "has unsent" (re-disabling Copy/Submit) and the sidebar refreshes — the same
// path a feedback write takes. Returns null when the review is unknown.
export async function buildAndMarkPrompt(
  id: string,
  feedbackIds?: string[],
): Promise<string | null> {
  const detail = await buildReviewDetail(id);
  if (!detail) return null;
  const { text, included } = buildUnsentPrompt(detail, { feedbackIds });
  if (included.feedback.length || included.replies.length) {
    db.markContentSent(id, included.feedback, included.replies);
    broadcast({ type: "review-updated", reviewId: id });
  }
  return text;
}

// Create an adhoc scratch review: an empty files/SCRATCH review plus a per-review
// directory under the scratch root. The agent drops files into that directory (its
// path is returned to the CLI) and the watcher keeps the review's file list +
// content live — no upload step. The id is minted up front so the directory name
// derives from it; if the insert throws, the orphaned directory is cleaned up.
export function createScratchReview(input: {
  repo: Repo;
  title?: string | null;
  summary?: string | null;
  meta?: Record<string, string>;
  created_by?: Creator;
}): Review {
  const id = newReviewId();
  createScratchDir(id);
  try {
    return db.createReview({
      id,
      repoId: input.repo.repoId,
      worktree: input.repo.descriptor,
      kind: "files",
      source: { ref: "SCRATCH", files: [] },
      meta: input.meta ?? {},
      title: input.title ?? null,
      summary: input.summary ?? null,
      created_by: input.created_by ?? "human",
    });
  } catch (err) {
    removeScratchDir(id);
    throw err;
  }
}

// Create a diff review: the row plus its first stored round. The
// patch text is the content of record from here on — `source` is provenance
// only. If the round insert throws, the orphaned row is cleaned up.
export function createDiffReview(input: {
  repo: Repo;
  source: { base: string; head: string };
  patch: string;
  label?: string | null;
  title?: string | null;
  summary?: string | null;
  meta?: Record<string, string>;
  created_by?: Creator;
}): Review | Rejected {
  if (Buffer.byteLength(input.patch, "utf8") > MAX_PATCH_BYTES) return { error: "patch too large" };
  if (!parsePatch(input.patch)) return { error: "empty diff (nothing to review)" };
  const review = db.createReview({
    repoId: input.repo.repoId,
    worktree: input.repo.descriptor,
    kind: "diff",
    source: input.source,
    meta: input.meta ?? {},
    title: input.title ?? null,
    summary: input.summary ?? null,
    created_by: input.created_by ?? "human",
  });
  try {
    db.addPatch(review.id, input.patch, input.label ?? defaultLabel(input.source));
  } catch (err) {
    db.deleteReview(review.id);
    throw err;
  }
  return review;
}

// "abc12345..def67890" with shas shortened — the round label when none is given.
function defaultLabel(source: { base: string; head: string }): string | null {
  const short = (s: string) => (/^[0-9a-f]{8,40}$/i.test(s) ? s.slice(0, 8) : s);
  if (!source.base && !source.head) return null;
  return `${short(source.base)}..${short(source.head)}`;
}

// Append a diff round (POST …/patches, `r3 diff add`). Rounds are the unit of
// change for a diff review — there is no hunk-level surgery; a wrong round is
// removed whole and re-added.
export function addPatchToReview(
  reviewId: string,
  raw: string,
  label: string | null,
  summary: string | null = null,
): { seq: number } | Rejected | null {
  const review = db.getReview(reviewId);
  if (!review) return null;
  if (review.kind !== "diff") return { error: "not a diff review — use r3 files add" };
  if (Buffer.byteLength(raw, "utf8") > MAX_PATCH_BYTES) return { error: "patch too large" };
  if (!parsePatch(raw)) return { error: "not a unified diff (or empty)" };
  const meta = db.addPatch(reviewId, raw, label, summary);
  broadcast({ type: "review-updated", reviewId });
  return { seq: meta.seq };
}

// Remove a round. Feedback/reply anchors pointing into it are kept — the UI
// renders them inert ("diff N removed") rather than cascading them away.
export function removePatch(reviewId: string, seq: number): boolean {
  const ok = db.deletePatch(reviewId, seq);
  if (ok) broadcast({ type: "review-updated", reviewId });
  return ok;
}

// Capture a content snapshot of a files review (POST …/snapshots, `r3 snapshot`).
// Freezes every file's current text; the derived diff between two
// snapshots — or a snapshot and live — is what the human reads to see what the
// agent changed. Diff reviews reject: their history is stored rounds (`r3 diff
// add`). Needs a readable worktree/scratch dir to snapshot from.
export async function snapshotReview(
  reviewId: string,
  label: string | null,
): Promise<SnapshotMeta | Rejected | null> {
  const review = db.getReview(reviewId);
  if (!review) return null;
  if (review.kind !== "files")
    return { error: "not a files review — diff reviews append rounds with r3 diff add" };
  const repo = await resolveRepoForReview(review);
  if (!repo || (repo.stale && !isScratchReview(review)))
    return { error: "worktree unavailable — can't read the review's files to snapshot" };
  const meta = await captureSnapshot(repo, review, label);
  if (!meta) return { error: "no readable files in this review to snapshot" };
  broadcast({ type: "review-updated", reviewId });
  return meta;
}

// Remove a snapshot whole (`r3 snapshot rm`). Feedback isn't scoped to snapshots
// (quote-first display), so nothing orphans — the snapshot just leaves the
// from/to picker.
export function removeSnapshot(reviewId: string, seq: number): boolean {
  const ok = db.deleteSnapshot(reviewId, seq);
  if (ok) broadcast({ type: "review-updated", reviewId });
  return ok;
}

// Edit a files review's membership (POST …/files, `r3 files add/rm`). Paths are
// checked for shape here (relative, no `..`) and against the worktree at render
// time (safePath) — a bad path yields "not found" content, never an escape.
export function updateReviewFiles(
  reviewId: string,
  body: { add?: string[]; remove?: string[] },
): Review | Rejected | null {
  const review = db.getReview(reviewId);
  if (!review) return null;
  if (review.kind !== "files" || !("ref" in review.source))
    return { error: "not a files review — use r3 diff add" };
  if (isScratchReview(review))
    return { error: "scratch reviews derive their files from the scratch directory" };
  const bad = (p: string) =>
    !p || p.startsWith("/") || p.split("/").includes("..") || p.includes("\0");
  for (const p of [...(body.add ?? []), ...(body.remove ?? [])]) {
    if (bad(p)) return { error: `bad path: ${p}` };
  }
  const remove = new Set(body.remove ?? []);
  const files = review.source.files.filter((f) => !remove.has(f));
  for (const p of body.add ?? []) if (!files.includes(p)) files.push(p);
  const updated = db.updateReviewSource(reviewId, { ...review.source, files });
  // New files need an anchor pass on next fetch; the watcher picks them up on
  // its next refresh tick.
  markDirty(reviewId);
  broadcast({ type: "review-updated", reviewId });
  return updated;
}

// One-time forward migration: snapshot each legacy diff review's
// live `git diff base..head` into a stored round 1, converging every diff
// review on the rounds model. Unresolvable repos are skipped and keep the
// live-render fallback (GET …/diff) until they resolve; re-running is
// idempotent because migrated reviews have patches. Legacy feedback keeps
// patch_seq NULL, which the UI treats as "the first/only round".
export async function migrateLegacyDiffReviews(): Promise<void> {
  for (const review of db.listReviews({})) {
    if (review.kind !== "diff" || db.hasPatches(review.id)) continue;
    const src = review.source as { base: string; head: string };
    if (!src.base && !src.head) continue;
    const repo = await resolveRepoForReview(review, { touch: false });
    if (!repo || repo.stale) continue;
    try {
      const raw = await snapshotDiff(repo, src.base, src.head);
      if (parsePatch(raw)) db.addPatch(review.id, raw, defaultLabel(src));
    } catch {
      // repo present but the refs are gone (rebase, gc) — stays on the fallback
    }
  }
}

// Delete a review and (for scratch docs) its backing storage, broadcasting so other
// tabs drop it from the sidebar. Feedback/replies cascade in SQL.
export function deleteReview(id: string): boolean {
  const review = db.getReview(id);
  if (!review) return false;
  const ok = db.deleteReview(id);
  if (ok) {
    deleteScratch(review);
    forget(id); // drop its dirty-registry entries (see dirty.ts)
    broadcast({ type: "reviews-changed" });
  }
  return ok;
}

// Forget a repo and all its reviews (cascade). The SQL cascade can't reach the
// scratch files in the data dir, so unlink them first (no-op for non-scratch).
export function deleteRepo(repoId: string): boolean {
  for (const review of db.listReviews({ repoId })) {
    deleteScratch(review);
    forget(review.id); // drop its dirty-registry entries (see dirty.ts)
  }
  return db.deleteRepo(repoId);
}

// Resolve the Repo a review's content routes (diff/blob) must run against.
export async function repoForReview(id: string): Promise<Repo | null> {
  const review = db.getReview(id);
  if (!review) return null;
  return resolveRepoForReview(review);
}

export async function addFeedback(
  reviewId: string,
  body: CreateFeedbackBody,
): Promise<Feedback | null> {
  const review = db.getReview(reviewId);
  if (!review) return null;
  const codeSha = body.quote ? await blobSha(body.quote) : null;
  // A patch_seq must name a stored round; anything else (files review, legacy
  // live render, stray number) is stored as null = "the first/only round".
  const patchSeq =
    body.patchSeq != null && db.getPatch(reviewId, body.patchSeq) ? body.patchSeq : null;
  const fb = db.createFeedback(reviewId, {
    author: body.author ?? "human",
    body: body.body,
    file: body.file ?? "", // empty for general (review-level) feedback
    // A files review's canonical anchor is the single-sided live file, so its
    // feedback is sideless — even when left on the old (deleted) side of a
    // snapshot-diff view. The diff view re-derives the side by quote at display
    // time; persisting side='old' would leave it unmatchable in the live file
    // view (which renders only a 'new' side). Diff reviews keep the picked side.
    side: review.kind === "files" ? null : (body.side ?? null),
    line_start: body.lineStart,
    line_end: body.lineEnd,
    quote: body.quote ?? null,
    code_sha: codeSha,
    patch_seq: patchSeq,
  });
  // Feedback on a files review may have been left against a snapshot or a
  // snapshot-diff view, whose line numbers differ from the live file. Mark the
  // review dirty so the next detail build re-anchors the new feedback's quote to
  // live content — the canonical anchor stays live regardless of the view it was
  // created in.
  if (review.kind === "files") markDirty(reviewId);
  broadcast({ type: "feedback-updated", reviewId, feedbackId: fb.id });
  broadcast({ type: "review-updated", reviewId });
  return fb;
}

const ACTION_STATUS = {
  accept: "accepted",
  refute: "refuted",
  resolve: "resolved",
  followup: "open",
} as const;

export function applyReply(
  feedbackId: string,
  body: AddReplyBody,
): { reply: Reply; feedback: Feedback } | Rejected | null {
  const fb = db.getFeedback(feedbackId);
  if (!fb) return null;
  // Only a known action drives status; an unknown string (including inherited
  // keys like "toString"/"__proto__") is recorded as a plain reply, not a status.
  const action = body.action && Object.hasOwn(ACTION_STATUS, body.action) ? body.action : null;
  // An anchored reply pins where the change addressing this feedback landed.
  // Validate against the stored round now — rounds are immutable,
  // so a pin that passes here holds forever.
  if (body.patchSeq != null) {
    const err = validateReplyPin(fb.review_id, {
      patchSeq: body.patchSeq,
      file: body.file,
      quote: body.quote,
    });
    if (err) return { error: err };
  }
  // Pin the version this reply's inline `@path:Lx-y` refs resolve against: the
  // latest stored round (diff reviews) or content snapshot (files reviews) at post
  // time. The agent controls old-vs-new by ordering the snapshot/round before or
  // after the reply; null when there's nothing captured yet.
  const review = db.getReview(fb.review_id);
  const seqs =
    review?.kind === "diff"
      ? db.listPatchMetas(fb.review_id).map((p) => p.seq)
      : review?.kind === "files"
        ? db.listSnapshotMetas(fb.review_id).map((s) => s.seq)
        : [];
  const refVersion = seqs.length ? Math.max(...seqs) : null;
  const reply = db.createReply(feedbackId, {
    author: body.author ?? "agent",
    action,
    body: body.body,
    patch_seq: body.patchSeq ?? null,
    file: body.patchSeq != null ? (body.file ?? null) : null,
    line_start: body.patchSeq != null ? (body.lineStart ?? null) : null,
    line_end: body.patchSeq != null ? (body.lineEnd ?? null) : null,
    quote: body.patchSeq != null ? (body.quote ?? null) : null,
    ref_version: refVersion,
  });
  let feedback = fb;
  if (action) {
    feedback = db.updateFeedback(feedbackId, { status: ACTION_STATUS[action] }) ?? fb;
  }
  broadcast({ type: "feedback-updated", reviewId: fb.review_id, feedbackId });
  broadcast({ type: "review-updated", reviewId: fb.review_id });
  return { reply, feedback };
}

export async function reanchorFeedback(
  feedbackId: string,
  body: { file?: string; lineStart: number | null; lineEnd: number | null; quote?: string | null },
): Promise<Feedback | Rejected | null> {
  const fb = db.getFeedback(feedbackId);
  if (!fb) return null;
  // Summary feedback's quote is its whole anchor (there's no worktree file behind
  // it), so re-anchoring doesn't apply.
  if (fb.file === SUMMARY_FILE)
    return { error: "summary feedback isn't re-anchorable — its quote is the anchor" };
  // Diff-review anchors live in immutable stored rounds — they can't drift, so
  // there's nothing to re-anchor. "Where the fix landed" is an anchored reply.
  const review = db.getReview(fb.review_id);
  if (review?.kind === "diff")
    return {
      error:
        "diff reviews don't re-anchor (rounds are immutable) — pin an anchored reply instead: r3 reply <fid> --diff <seq> --file <f> --line <a-b>",
    };
  const quote = body.quote ?? fb.quote;
  const codeSha = quote ? await blobSha(quote) : fb.code_sha;
  const next = db.updateFeedback(feedbackId, {
    file: body.file ?? fb.file,
    line_start: body.lineStart,
    line_end: body.lineEnd,
    quote,
    code_sha: codeSha,
    anchor: "anchored",
  });
  broadcast({ type: "feedback-updated", reviewId: fb.review_id, feedbackId });
  broadcast({ type: "review-updated", reviewId: fb.review_id });
  return next;
}

export function editFeedback(
  feedbackId: string,
  fields: { body?: string; status?: Feedback["status"] },
): Feedback | null {
  const fb = db.getFeedback(feedbackId);
  if (!fb) return null;
  const next = db.updateFeedback(feedbackId, fields);
  // If the human changed the *body* of an already-delivered feedback, reset its
  // delivery marker so it re-delivers — otherwise the edited text
  // stays invisible to the agent (Copy/Submit disabled, omitted from the unsent
  // prompt). A status-only edit leaves sent_at as-is.
  if (fields.body !== undefined && fields.body !== fb.body) db.clearFeedbackSent(feedbackId);
  broadcast({ type: "feedback-updated", reviewId: fb.review_id, feedbackId });
  broadcast({ type: "review-updated", reviewId: fb.review_id });
  return next;
}

export function deleteFeedback(feedbackId: string): boolean {
  const fb = db.getFeedback(feedbackId);
  if (!fb) return false;
  const ok = db.deleteFeedback(feedbackId);
  if (ok) broadcast({ type: "review-updated", reviewId: fb.review_id });
  return ok;
}

// Edit a reply's prose (human-only convenience). Pushes the same events as a
// feedback edit so the thread updates live in every open client.
export function editReply(replyId: string, body: string): Reply | null {
  const rp = db.getReply(replyId);
  if (!rp) return null;
  const fb = db.getFeedback(rp.feedback_id);
  const next = db.updateReply(replyId, body);
  if (fb) {
    broadcast({ type: "feedback-updated", reviewId: fb.review_id, feedbackId: fb.id });
    broadcast({ type: "review-updated", reviewId: fb.review_id });
  }
  return next;
}
