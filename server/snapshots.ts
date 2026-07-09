// Files-review content snapshots. A snapshot freezes the full text of
// every file currently in a `kind:'files'` review; the daemon can then derive an
// accurate diff between any two snapshots — or a snapshot and the live working
// content — on demand (textdiff.ts), with no git and no temp files (so it works
// for scratch reviews too). Contrast diff reviews' stored *rounds*, which hold
// unified-diff text: snapshots hold whole files, which is what lets the from/to
// picker diff any pair. Feedback is never scoped to a snapshot — it stays anchored
// to the live file (quote-first) and is located by quote in whatever view shows;
// these functions are therefore feedback-agnostic.

import { statSync } from "node:fs";
import type { DiffFileChange, RenderedFile, Review, SnapshotMeta } from "../shared/types.ts";
import * as db from "./db.ts";
import { blobSha, readContentAt } from "./git.ts";
import { escapeHtml, highlightToLines, langForPath } from "./highlight.ts";
import { renderContent } from "./render.ts";
import type { Repo } from "./repo.ts";
import { isScratchReview, scratchFiles, scratchSafePath } from "./scratch.ts";
import { diffFile } from "./textdiff.ts";

// Per-file cap on captured content — snapshots live as TEXT rows in the global
// sqlite, so an accidentally-huge file shouldn't bloat it. Files review content is
// design docs / source; anything past this is skipped (like a binary), same as the
// diff-round cap's intent.
const MAX_SNAPSHOT_FILE_BYTES = 4 * 1024 * 1024;

// The paths currently in a files review: a scratch review derives them live from
// its directory; a worktree-backed one lists its stored membership.
function currentFiles(review: Review): string[] {
  if (isScratchReview(review)) return scratchFiles(review);
  return "files" in review.source ? review.source.files : [];
}

function sourceRef(review: Review): string {
  return "ref" in review.source ? review.source.ref : "WORKING";
}

// Capture a snapshot: read each file's current content and store it. A file that
// EXISTS but can't be diffed as text (binary, or over the storage cap) is stored
// as a marker row (empty content, skipped=1) rather than omitted — so a later
// derived diff shows it as a binary placeholder instead of misreading it as a
// full deletion. Only truly-missing files are omitted. Returns the
// new meta, or null when the review has no files present at all to capture.
export async function captureSnapshot(
  repo: Repo,
  review: Review,
  label: string | null,
): Promise<SnapshotMeta | null> {
  const ref = sourceRef(review);
  const files: db.SnapshotFileInput[] = [];
  for (const path of currentFiles(review)) {
    // WORKING/SCRATCH live on disk: stat the file and skip an oversize one WITHOUT
    // reading it — readContentAt would otherwise materialize the whole file before
    // the cap below could reject it. Resolve the path the same way readContentAt's
    // fs branch does; a git-ref read has no cheap size check and falls through to
    // the post-read cap (also a backstop against a stat→read size race here).
    const fsPath =
      ref === "SCRATCH" ? scratchSafePath(path) : ref === "WORKING" ? repo.safePath(path) : null;
    if (fsPath) {
      try {
        if (statSync(fsPath).size > MAX_SNAPSHOT_FILE_BYTES) {
          files.push({ path, content: "", sha: "", skipped: true });
          continue;
        }
      } catch {} // missing/unreadable — let readContentAt below decide (omit)
    }
    const content = await readContentAt(repo, path, ref);
    if (content == null) continue; // truly missing — omit (a real absence vs. a prior snapshot)
    // Present but non-diffable: record its existence without storing bytes, so
    // the phantom-deletion misrepresentation can't happen.
    if (content.includes("\0") || Buffer.byteLength(content, "utf8") > MAX_SNAPSHOT_FILE_BYTES) {
      files.push({ path, content: "", sha: "", skipped: true });
      continue;
    }
    files.push({ path, content, sha: await blobSha(content) });
  }
  if (files.length === 0) return null;
  return db.addSnapshot(review.id, files, label);
}

// One file's state at a snapshot ref, distinguishing the three cases the diff
// must tell apart: `absent` (content null, skipped false — no such
// file here), `text` (content non-null), and `binary` (skipped true — present but
// not diffable as text). `from` is always a stored snapshot seq; `to` may be
// WORKING (live). WORKING is unavailable when the worktree is gone — either the
// repo didn't resolve (repo null) or it resolved *stale*: a moved/removed
// worktree falls back to the primary tree, whose same-relative-path files are NOT
// this review's, so we must not read them (matching the /api/blob guard). SCRATCH
// content lives in the data dir, so staleness doesn't apply to it. A live binary
// file becomes a `binary` marker too, so the diff treats it like a stored skipped
// file rather than diffing raw bytes.
interface FileState {
  content: string | null;
  skipped: boolean;
}
async function fileAt(
  reviewId: string,
  ref: number | "WORKING",
  path: string,
  repo: Repo | null,
  review: Review,
): Promise<FileState> {
  if (ref === "WORKING") {
    if (!repo) return { content: null, skipped: false };
    const srcRef = sourceRef(review);
    if (repo.stale && srcRef !== "SCRATCH") return { content: null, skipped: false };
    const content = await readContentAt(repo, path, srcRef);
    if (content == null) return { content: null, skipped: false };
    // A live binary file has no text to diff — mark it present-but-non-diffable,
    // same as a stored skipped file. No storage-cap check here: a live view isn't
    // storage-bound; the cap only governs what captureSnapshot persists.
    if (content.includes("\0")) return { content: null, skipped: true };
    return { content, skipped: false };
  }
  const row = db.getSnapshotFile(reviewId, ref, path);
  if (!row) return { content: null, skipped: false };
  return row.skipped ? { content: null, skipped: true } : { content: row.content, skipped: false };
}

// A DiffFileChange for a file that's present-but-non-diffable (binary/oversize)
// on either side. Reuses the UI's existing binary path (binary:true,
// no line rows) so a skipped file never renders as a phantom deletion of the
// other side's readable content. Returns null for the both-binary case: with no
// stored bytes on either side we can't tell whether it changed, and prior
// behavior omitted binary files entirely, so surfacing an unchanged binary as
// "modified" on every diff would be pure noise.
function binaryPlaceholder(
  path: string,
  oldSide: FileState,
  newSide: FileState,
): DiffFileChange | null {
  if (oldSide.skipped && newSide.skipped) return null;
  const oldPresent = oldSide.content != null || oldSide.skipped;
  const newPresent = newSide.content != null || newSide.skipped;
  const status: DiffFileChange["status"] = !oldPresent
    ? "added"
    : !newPresent
      ? "deleted"
      : "modified";
  return {
    oldPath: status === "added" ? null : path,
    newPath: status === "deleted" ? null : path,
    path,
    status,
    binary: true,
    additions: 0,
    deletions: 0,
    lines: [],
  };
}

// Highlight a derived diff's rows from the full old/new contents (accurate
// multi-line context — better than a hunk-only reconstruction), mapping each row
// by its old/new line number. Mirrors git.ts's highlightFiles, but the contents
// are already in hand rather than read from a ref.
async function highlightDiff(
  f: DiffFileChange,
  oldContent: string | null,
  newContent: string | null,
  theme?: string,
): Promise<void> {
  const lang = langForPath(f.path);
  const hl = async (content: string | null) =>
    content == null ? null : highlightToLines(content, lang, await blobSha(content), theme);
  const [oldHl, newHl] = await Promise.all([hl(oldContent), hl(newContent)]);
  for (const ln of f.lines) {
    if (ln.type === "hunk") continue;
    if (ln.newLine != null && newHl?.[ln.newLine - 1] != null) ln.html = newHl[ln.newLine - 1];
    else if (ln.oldLine != null && oldHl?.[ln.oldLine - 1] != null) ln.html = oldHl[ln.oldLine - 1];
    else ln.html = escapeHtml(ln.text);
  }
}

// A files review's diff between two snapshot refs: `from` is a snapshot seq, `to`
// a snapshot seq or WORKING (live). Only changed files are returned, path-sorted.
export async function renderSnapshotDiff(
  reviewId: string,
  from: number,
  to: number | "WORKING",
  repo: Repo | null,
  review: Review,
  theme?: string,
): Promise<DiffFileChange[]> {
  const fromPaths = db.snapshotFilePaths(reviewId, from);
  const toPaths = to === "WORKING" ? currentFiles(review) : db.snapshotFilePaths(reviewId, to);
  const paths = [...new Set([...fromPaths, ...toPaths])].sort();

  const out: DiffFileChange[] = [];
  for (const path of paths) {
    const oldSide = await fileAt(reviewId, from, path, repo, review);
    const newSide = await fileAt(reviewId, to, path, repo, review);
    // Either side present-but-non-diffable (binary/oversize/skipped): render a
    // binary placeholder instead of a line diff — and never as a phantom deletion
    // of the readable side, which is the misrepresentation this fixes.
    if (oldSide.skipped || newSide.skipped) {
      const placeholder = binaryPlaceholder(path, oldSide, newSide);
      if (placeholder) out.push(placeholder);
      continue;
    }
    const oldContent = oldSide.content;
    const newContent = newSide.content;
    const f = diffFile(path, oldContent, newContent);
    if (!f) continue;
    await highlightDiff(f, oldContent, newContent, theme);
    out.push(f);
  }
  return out;
}

// A files review's file rendered at a snapshot ref (full-file view for the
// from=None browse mode). WORKING reads live; a seq reads the stored content.
export async function renderSnapshotBlob(
  reviewId: string,
  to: number | "WORKING",
  path: string,
  repo: Repo | null,
  review: Review,
  theme?: string,
): Promise<RenderedFile | null> {
  const side = await fileAt(reviewId, to, path, repo, review);
  // A present-but-non-diffable file (binary/oversize marker, or a live binary)
  // has no text to render — return null (the route 404s) rather than rendering an
  // empty file from the marker row's stored "". Truly-absent also returns null.
  if (side.content == null) return null;
  const label = to === "WORKING" ? sourceRef(review) : `snapshot:${to}`;
  return renderContent(path, side.content, label, theme);
}
