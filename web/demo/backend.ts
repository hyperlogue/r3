// The in-browser "backend". It reimplements the daemon's domain rules against the
// localStorage store, reusing the server's genuinely PURE modules verbatim — the
// quote relocation (anchor.ts), the line differ (textdiff.ts), the agent-prompt
// builder (prompt.ts), and the unsent predicate (shared/types.ts). Everything git-
// or sqlite-bound is replaced by the store; every rendered payload is pre-baked at
// build time, so no highlighter ships to the browser (see model.ts / fixtures).
//
// The rules here mirror server/reviews.ts closely (derive-quote, delivery/sent_at
// bookkeeping, re-anchoring, the SSE events fired) so the UI behaves identically.

import { findQuote, normalizeWs, projectDoc } from "../../server/anchor.ts";
import { buildUnsentPrompt } from "../../server/prompt.ts";
import { diffFile } from "../../server/textdiff.ts";
import {
  type AddReplyBody,
  type CreateFeedbackBody,
  type Feedback,
  type FeedbackWithReplies,
  MAX_QUOTE_LINES,
  type ReanchorBody,
  type RenderedFile,
  type Reply,
  type Review,
  type ReviewDetail,
  type ReviewDiffResponse,
  type SnapshotDiffResponse,
  type SnapshotMeta,
  type SnapshotRef,
  SUMMARY_FILE,
  type UpdateReviewBody,
} from "../../shared/types.ts";
import { broadcast } from "./bus.ts";
import { ApiError } from "./errors.ts";
import type { StoredPatch } from "./model.ts";
import { contentSha, getState, mintId, nowIso, persist } from "./store.ts";
import { isWatching } from "./watchers.ts";

// ---- small pure helpers (browser-safe stand-ins for highlight.ts) ----

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Cap a derived quote the same way the server does (short quotes relocate better);
// the recorded line range still spans the full selection.
function capQuote(text: string): string {
  const lines = text.split("\n");
  return lines.length > MAX_QUOTE_LINES ? lines.slice(0, MAX_QUOTE_LINES).join("\n") : text;
}

// A files-review file's live text as an array of real lines (drop the phantom
// trailing "" that split("\n") leaves on newline-terminated content).
function liveLines(reviewId: string, file: string): string[] | null {
  const content = getState().fileContents[reviewId]?.[file];
  if (content == null) return null;
  const all = content.split("\n");
  if (content.endsWith("\n")) all.pop();
  return all;
}

// ---- lookups ----

const s = getState;
const review = (id: string): Review | undefined => s().reviews.find((r) => r.id === id);
const feedbackRow = (id: string): Feedback | undefined => s().feedback.find((f) => f.id === id);
const patchesFor = (id: string): StoredPatch[] =>
  s()
    .patches.filter((p) => p.review_id === id)
    .sort((a, b) => a.seq - b.seq);

function require404<T>(v: T | undefined | null, what: string): T {
  if (v == null) throw new ApiError(404, `${what} not found`);
  return v;
}

// ---- re-anchoring (files reviews) — mirrors reviews.reanchorReview ----

function reanchorFilesReview(rv: Review): void {
  if (rv.kind !== "files") return;
  const docs = new Map<string, ReturnType<typeof projectDoc> | null>();
  for (const fb of s().feedback) {
    if (fb.review_id !== rv.id || !fb.quote || fb.file === SUMMARY_FILE) continue;
    let doc = docs.get(fb.file);
    if (doc === undefined) {
      const content = getState().fileContents[rv.id]?.[fb.file];
      doc = content == null ? null : projectDoc(content);
      docs.set(fb.file, doc);
    }
    if (doc == null) {
      fb.anchor = "outdated";
      continue;
    }
    const match = findQuote(doc, fb.quote, fb.line_start);
    if (!match) {
      fb.anchor = "outdated";
      continue;
    }
    fb.line_start = match.lineStart;
    fb.line_end = match.lineEnd;
    fb.code_sha = contentSha(match.text);
    fb.anchor = "anchored";
  }
}

// ---- review detail ----

export function buildDetail(id: string): ReviewDetail {
  const rv = require404(review(id), "review");
  if (rv.kind === "files") reanchorFilesReview(rv);
  const feedback: FeedbackWithReplies[] = s()
    .feedback.filter((f) => f.review_id === id)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((fb) => ({
      ...fb,
      replies: s()
        .replies.filter((r) => r.feedback_id === fb.id)
        .sort((a, b) => a.created_at.localeCompare(b.created_at)),
    }));
  const patches = patchesFor(id).map(({ seq, label, summary, created_at }) => ({
    seq,
    label,
    summary,
    created_at,
  }));
  const snapshots: SnapshotMeta[] = s()
    .snapshots.filter((sn) => sn.review_id === id)
    .sort((a, b) => a.seq - b.seq)
    .map(({ seq, label, created_at, files }) => ({ seq, label, created_at, files }));
  return {
    ...rv,
    feedback,
    stale: false,
    repoName: s().repo.name,
    branch: rv.worktree?.branch ?? null,
    scratchDir: null,
    scratchIgnoredDirs: [],
    patches: rv.kind === "diff" ? patches : [],
    snapshots: rv.kind === "files" ? snapshots : [],
  };
}

export function listReviews(filter: {
  session?: string;
  status?: string;
  repo?: string;
}): Review[] {
  return s()
    .reviews.filter((r) => {
      if (filter.status && r.status !== filter.status) return false;
      if (filter.session && r.meta.session !== filter.session) return false;
      if (filter.repo && r.repo_id !== filter.repo) return false;
      return true;
    })
    .map((r) => ({ ...r, watching: isWatching(r.id) }))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

// ---- rendered content (pre-baked, with a plain fallback for edited content) ----

export function reviewDiff(id: string): ReviewDiffResponse {
  return {
    rounds: patchesFor(id).map(({ seq, label, summary, created_at, files }) => ({
      seq,
      label,
      summary,
      created_at,
      files,
    })),
  };
}

function plainRenderFile(path: string, content: string, ref: string): RenderedFile {
  const srcLines = content.split("\n");
  if (content.length > 0 && content.endsWith("\n")) srcLines.pop();
  return {
    path,
    ref,
    kind: "code",
    lang: null,
    sha: contentSha(content),
    lines: srcLines.map((text, i) => ({ lineNo: i + 1, html: escapeHtml(text), text })),
    markdownHtml: null,
  };
}

export function blob(path: string, ref: string, reviewId?: string): RenderedFile {
  if (reviewId) {
    const pre = s().blobs.find((b) => b.review_id === reviewId && b.path === path && b.ref === ref);
    if (pre) return pre.rendered;
    const content = getState().fileContents[reviewId]?.[path];
    if (content != null) return plainRenderFile(path, content, ref);
  }
  throw new ApiError(404, `no rendered file for ${path}`);
}

export function snapshots(id: string): SnapshotMeta[] {
  return buildDetail(id).snapshots;
}

// Content at a snapshot ref: a numbered snapshot's stored text, or live content.
function contentAt(reviewId: string, to: SnapshotRef, path: string): string | undefined {
  if (to === "WORKING") return getState().fileContents[reviewId]?.[path];
  return s().snapshots.find((sn) => sn.review_id === reviewId && sn.seq === to)?.contents[path];
}

export function snapshotDiff(id: string, from: number, to: SnapshotRef): SnapshotDiffResponse {
  const pre = s().snapshotDiffs.find((d) => d.review_id === id && d.from === from && d.to === to);
  if (pre) return { from, to, files: pre.files };
  // Derive in-browser via the pure differ (uncoloured — an edited-content path).
  const fromSnap = require404(
    s().snapshots.find((sn) => sn.review_id === id && sn.seq === from),
    `snapshot ${from}`,
  );
  const toContents = s().snapshots.find((sn) => sn.review_id === id && sn.seq === to)?.contents;
  const paths = new Set<string>([
    ...Object.keys(fromSnap.contents),
    ...Object.keys(to === "WORKING" ? (getState().fileContents[id] ?? {}) : (toContents ?? {})),
  ]);
  const files = [];
  for (const path of paths) {
    const dfc = diffFile(path, fromSnap.contents[path] ?? "", contentAt(id, to, path) ?? "");
    if (!dfc) continue;
    for (const ln of dfc.lines) if (ln.type !== "hunk") ln.html = escapeHtml(ln.text);
    files.push(dfc);
  }
  return { from, to, files };
}

export function snapshotBlob(id: string, path: string, to: SnapshotRef): RenderedFile {
  const content = contentAt(id, to, path);
  if (content == null) throw new ApiError(404, `no ${path} at snapshot ${to}`);
  if (to === "WORKING") return blob(path, "WORKING", id);
  return plainRenderFile(path, content, `snapshot ${to}`);
}

// ---- derive-quote + membership validation (mirrors reviews.ts) ----

function deriveQuote(
  rv: Review,
  patchSeq: number | null,
  file: string,
  side: "old" | "new" | null,
  lineStart: number,
  lineEnd: number,
): string {
  if (rv.kind === "diff") {
    const patch = patchSeq != null ? patchesFor(rv.id).find((p) => p.seq === patchSeq) : undefined;
    if (!patch)
      throw new ApiError(400, "quote required — this review has no stored round to derive it from");
    const f = patch.files.find((x) => x.path === file || x.oldPath === file);
    if (!f) throw new ApiError(400, `diff ${patchSeq} doesn't touch ${file}`);
    const want = side ?? "new";
    const rows = f.lines.filter((ln) => {
      if (ln.type === "hunk") return false;
      const n = want === "new" ? ln.newLine : ln.oldLine;
      return n != null && n >= lineStart && n <= lineEnd;
    });
    if (rows.length !== lineEnd - lineStart + 1)
      throw new ApiError(
        400,
        `L${lineStart}-${lineEnd} (${want} side) isn't fully in diff ${patchSeq} for ${file}`,
      );
    const text = capQuote(rows.map((ln) => ln.text).join("\n"));
    if (!text.trim())
      throw new ApiError(400, `L${lineStart}-${lineEnd} in diff ${patchSeq} is blank`);
    return text;
  }
  const all = liveLines(rv.id, file);
  if (all == null) throw new ApiError(400, `can't read ${file} to anchor — check the path`);
  const range = `L${lineStart}${lineEnd !== lineStart ? `-${lineEnd}` : ""}`;
  if (lineEnd > all.length)
    throw new ApiError(400, `${file} has ${all.length} lines — ${range} is out of range`);
  const text = capQuote(all.slice(lineStart - 1, lineEnd).join("\n"));
  if (!text.trim()) throw new ApiError(400, `${file} ${range} is blank`);
  return text;
}

function validateFeedbackFile(rv: Review, file: string, patchSeq: number | null): void {
  if (rv.kind === "diff") {
    const seqs =
      patchSeq != null
        ? [patchSeq]
        : patchesFor(rv.id)
            .map((p) => p.seq)
            .reverse();
    if (!seqs.length) return;
    for (const seq of seqs) {
      const patch = patchesFor(rv.id).find((p) => p.seq === seq);
      if (patch?.files.some((x) => x.path === file || x.oldPath === file)) return;
    }
    throw new ApiError(400, `${file} isn't touched by this review's diffs — check the path`);
  }
  const src = rv.source as { ref: string; files: string[] };
  if (src.files.includes(file)) return;
  if (getState().fileContents[rv.id]?.[file] != null) return;
  throw new ApiError(
    400,
    `${file} isn't part of this review — check the path against its file list`,
  );
}

// ---- feedback + replies ----

export function addFeedback(reviewId: string, body: CreateFeedbackBody): Feedback {
  const rv = require404(review(reviewId), "review");
  const author = body.author ?? "human";
  const lineAnchored = !!body.file && body.file !== SUMMARY_FILE && body.lineStart != null;
  if (lineAnchored) {
    const ls = body.lineStart as number;
    const le = body.lineEnd ?? ls;
    if (!Number.isInteger(ls) || ls < 1 || !Number.isInteger(le) || le < ls)
      throw new ApiError(400, "bad line range — expects integers 1 ≤ start ≤ end");
  }
  let patchSeq: number | null = null;
  if (rv.kind === "diff") {
    if (body.patchSeq != null && body.patchSeq >= 1) {
      if (!patchesFor(reviewId).some((p) => p.seq === body.patchSeq))
        throw new ApiError(400, `no diff ${body.patchSeq} in this review`);
      patchSeq = body.patchSeq;
    } else if (body.patchSeq == null && lineAnchored) {
      const metas = patchesFor(reviewId);
      patchSeq = metas.length ? metas[metas.length - 1].seq : null;
    }
  }
  const side =
    rv.kind === "files" ? null : lineAnchored ? (body.side ?? "new") : (body.side ?? null);
  let quote = body.quote ?? null;
  if (quote == null && lineAnchored) {
    quote = deriveQuote(
      rv,
      patchSeq,
      body.file as string,
      side,
      body.lineStart as number,
      body.lineEnd ?? (body.lineStart as number),
    );
  }
  const realFile = !!body.file && body.file !== SUMMARY_FILE;
  if (realFile && (!lineAnchored || body.quote != null)) {
    validateFeedbackFile(rv, body.file as string, patchSeq);
  }
  const ts = nowIso();
  const fb: Feedback = {
    id: mintId("feedback"),
    review_id: reviewId,
    author,
    body: body.body,
    file: body.file ?? "",
    side,
    line_start: body.lineStart,
    line_end: body.lineEnd,
    quote,
    code_sha: quote ? contentSha(quote) : null,
    anchor: "anchored",
    status: "open",
    patch_seq: patchSeq,
    created_at: ts,
    updated_at: ts,
    // Agent-authored feedback is born delivered — only the human's replies /
    // resolution flow back through the prompt.
    sent_at: author === "agent" ? ts : null,
    status_unsent: false,
  };
  s().feedback.push(fb);
  persist();
  broadcast({ type: "feedback-updated", reviewId, feedbackId: fb.id });
  return fb;
}

// Validate a reply pin against a stored round (rounds are immutable → valid
// forever). Mirrors patches.validateReplyPin over the pre-parsed rows.
function validateReplyPin(
  reviewId: string,
  pin: { patchSeq: number; file?: string | null; quote?: string | null },
): string | null {
  const patch = patchesFor(reviewId).find((p) => p.seq === pin.patchSeq);
  if (!patch) return `no diff ${pin.patchSeq} in this review`;
  if (!pin.file) return null;
  const f = patch.files.find((x) => x.path === pin.file || x.oldPath === pin.file);
  if (!f) return `diff ${pin.patchSeq} doesn't touch ${pin.file}`;
  if (!pin.quote) return null;
  const first = normalizeWs(pin.quote.split("\n", 1)[0]);
  if (!first) return null;
  const hit = f.lines.some((ln) => ln.type !== "hunk" && normalizeWs(ln.text).includes(first));
  return hit ? null : `quote not found in diff ${pin.patchSeq} ${pin.file}`;
}

export function addReply(
  feedbackId: string,
  body: AddReplyBody,
): { reply: Reply; feedback: Feedback } {
  const fb = require404(feedbackRow(feedbackId), "feedback");
  if (body.patchSeq != null) {
    const err = validateReplyPin(fb.review_id, {
      patchSeq: body.patchSeq,
      file: body.file,
      quote: body.quote,
    });
    if (err) throw new ApiError(400, err);
  }
  const rv = review(fb.review_id);
  const seqs =
    rv?.kind === "diff"
      ? patchesFor(fb.review_id).map((p) => p.seq)
      : rv?.kind === "files"
        ? s()
            .snapshots.filter((sn) => sn.review_id === fb.review_id)
            .map((sn) => sn.seq)
        : [];
  const refVersion = seqs.length ? Math.max(...seqs) : null;
  const author = body.author ?? "agent";
  const ts = nowIso();
  const reply: Reply = {
    id: mintId("reply"),
    feedback_id: feedbackId,
    author,
    body: body.body,
    patch_seq: body.patchSeq ?? null,
    file: body.patchSeq != null ? (body.file ?? null) : null,
    line_start: body.patchSeq != null ? (body.lineStart ?? null) : null,
    line_end: body.patchSeq != null ? (body.lineEnd ?? null) : null,
    quote: body.patchSeq != null ? (body.quote ?? null) : null,
    created_at: ts,
    // Human replies start undelivered (they gate the next prompt); an agent's own
    // reply is born delivered.
    sent_at: author === "agent" ? ts : null,
    ref_version: refVersion,
  };
  s().replies.push(reply);
  touchReview(fb.review_id);
  persist();
  broadcast({ type: "feedback-updated", reviewId: fb.review_id, feedbackId });
  return { reply, feedback: fb };
}

export function editFeedback(
  id: string,
  fields: { body?: string; status?: Feedback["status"] },
): Feedback {
  const fb = require404(feedbackRow(id), "feedback");
  const statusAfter = fields.status ?? fb.status;
  // A real status flip of a delivered item is content the agent hasn't heard.
  if (fields.status !== undefined && fields.status !== fb.status && fb.sent_at != null)
    fb.status_unsent = true;
  const bodyChanged = fields.body !== undefined && fields.body !== fb.body;
  if (fields.body !== undefined) fb.body = fields.body;
  if (fields.status !== undefined) fb.status = fields.status;
  fb.updated_at = nowIso();
  // Re-deliver an edited OPEN note in full; never null a resolved item's sent_at.
  if (bodyChanged && statusAfter === "open") fb.sent_at = null;
  touchReview(fb.review_id);
  persist();
  broadcast({ type: "feedback-updated", reviewId: fb.review_id, feedbackId: id });
  return fb;
}

export function reanchor(id: string, body: ReanchorBody): Feedback {
  const fb = require404(feedbackRow(id), "feedback");
  if (fb.file === SUMMARY_FILE) {
    if (fb.patch_seq != null)
      throw new ApiError(400, "a diff-round summary isn't re-anchorable (rounds are immutable)");
    if (body.quote == null || !body.quote.trim())
      throw new ApiError(
        400,
        "review-summary re-anchor needs a quote (the note's new anchor text)",
      );
    fb.line_start = body.lineStart ?? fb.line_start;
    fb.line_end = body.lineEnd ?? fb.line_end;
    fb.quote = body.quote;
    fb.code_sha = contentSha(body.quote);
    fb.anchor = "anchored";
    touchReview(fb.review_id);
    persist();
    broadcast({ type: "feedback-updated", reviewId: fb.review_id, feedbackId: id });
    return fb;
  }
  if (review(fb.review_id)?.kind === "diff")
    throw new ApiError(
      400,
      "diff reviews don't re-anchor (rounds are immutable) — pin an anchored reply",
    );
  const quote = body.quote ?? fb.quote;
  if (body.file !== undefined) fb.file = body.file;
  fb.line_start = body.lineStart;
  fb.line_end = body.lineEnd;
  fb.quote = quote;
  fb.code_sha = quote ? contentSha(quote) : fb.code_sha;
  fb.anchor = "anchored";
  touchReview(fb.review_id);
  persist();
  broadcast({ type: "feedback-updated", reviewId: fb.review_id, feedbackId: id });
  return fb;
}

export function deleteFeedback(id: string): { ok: true } {
  const fb = require404(feedbackRow(id), "feedback");
  const st = s();
  st.feedback = st.feedback.filter((f) => f.id !== id);
  st.replies = st.replies.filter((r) => r.feedback_id !== id);
  touchReview(fb.review_id);
  persist();
  broadcast({ type: "review-updated", reviewId: fb.review_id });
  return { ok: true };
}

export function editReply(id: string, bodyText: string): Reply {
  const reply = require404(
    s().replies.find((r) => r.id === id),
    "reply",
  );
  reply.body = bodyText;
  const fb = feedbackRow(reply.feedback_id);
  if (fb) {
    touchReview(fb.review_id);
    broadcast({ type: "feedback-updated", reviewId: fb.review_id, feedbackId: fb.id });
  }
  persist();
  return reply;
}

// ---- review header edits + lifecycle ----

export function patchReview(id: string, body: UpdateReviewBody): Review {
  const rv = require404(review(id), "review");
  if (body.status !== undefined) rv.status = body.status;
  if (body.title !== undefined) rv.title = body.title;
  if (body.summary !== undefined) rv.summary = body.summary;
  if (body.meta !== undefined) rv.meta = { ...rv.meta, ...body.meta };
  if (body.note !== undefined) {
    if (body.note === "" || body.note == null) delete rv.meta.next_steps;
    else rv.meta.next_steps = body.note;
  }
  rv.updated_at = nowIso();
  persist();
  broadcast({ type: "review-updated", reviewId: id });
  broadcast({ type: "reviews-changed" });
  return rv;
}

export function deleteReview(id: string): { ok: true } {
  require404(review(id), "review");
  const st = s();
  const feedbackIds = new Set(st.feedback.filter((f) => f.review_id === id).map((f) => f.id));
  st.reviews = st.reviews.filter((r) => r.id !== id);
  st.feedback = st.feedback.filter((f) => f.review_id !== id);
  st.replies = st.replies.filter((r) => !feedbackIds.has(r.feedback_id));
  st.patches = st.patches.filter((p) => p.review_id !== id);
  st.snapshots = st.snapshots.filter((sn) => sn.review_id !== id);
  st.blobs = st.blobs.filter((b) => b.review_id !== id);
  st.snapshotDiffs = st.snapshotDiffs.filter((d) => d.review_id !== id);
  delete st.fileContents[id];
  delete st.viewed[id];
  persist();
  broadcast({ type: "reviews-changed" });
  return { ok: true };
}

// ---- hand-off (prompt) ----

export function promptPreview(id: string): string {
  return buildUnsentPrompt(buildDetail(id)).text;
}

// The real POST /prompt: build the unsent-only text AND mark exactly what it
// rendered delivered. Returns the text plus the feedback ids it covered, so the
// api layer can kick the scripted agent (Copy prompt and Submit both do). Marking
// is idempotent (COALESCE on sent_at), so a second call is a safe no-op.
export function markPrompt(id: string): { text: string; feedbackIds: string[] } {
  const detail = buildDetail(id);
  const { text, included } = buildUnsentPrompt(detail);
  if (included.feedback.length || included.replies.length) {
    const ts = nowIso();
    for (const fid of included.feedback) {
      const fb = feedbackRow(fid);
      if (fb) {
        fb.sent_at = fb.sent_at ?? ts; // COALESCE — only stamp first delivery
        fb.status_unsent = false;
      }
    }
    for (const rid of included.replies) {
      const r = s().replies.find((x) => x.id === rid);
      if (r) r.sent_at = ts;
    }
    touchReview(id);
    persist();
    broadcast({ type: "review-updated", reviewId: id });
  }
  return { text, feedbackIds: included.feedback };
}

// ---- viewed marks ----

export function getViewed(id: string): Set<string> {
  return new Set(s().viewed[id] ?? []);
}

export function setViewed(id: string, key: string, viewed: boolean): { ok: true } {
  const cur = new Set(s().viewed[id] ?? []);
  if (viewed) cur.add(key);
  else cur.delete(key);
  s().viewed[id] = [...cur];
  persist();
  return { ok: true };
}

// ---- internals shared with the scripted agent ----

export function touchReview(id: string): void {
  const rv = review(id);
  if (rv) rv.updated_at = nowIso();
}

export const getReview = review;
export const getFeedback = feedbackRow;

// Append a round (the agent's follow-up on a diff review). Broadcasts
// review-updated so the new round appears live, exactly like `r3 diff add`.
export function appendRound(
  reviewId: string,
  round: Omit<StoredPatch, "review_id" | "seq" | "created_at">,
): number {
  const existing = patchesFor(reviewId);
  const seq = existing.length ? Math.max(...existing.map((p) => p.seq)) + 1 : 1;
  s().patches.push({ review_id: reviewId, seq, created_at: nowIso(), ...round });
  touchReview(reviewId);
  persist();
  broadcast({ type: "review-updated", reviewId });
  return seq;
}
