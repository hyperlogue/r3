// Stored diff rounds. A `kind:'diff'` review's content is an
// append-only list of immutable unified-diff patches ("rounds") owned by the
// daemon — where the diff came from (a commit, a range, the working tree, or a
// pipe) stops mattering the moment it's stored. Rounds are independent: round
// N's line numbers owe nothing to round N-1's, which is what makes "fix up an
// old commit" representable at all. Because a round never changes, feedback
// anchored into it can never orphan — diff reviews need no re-anchoring, no
// file watching, and no worktree to render (contrast files reviews, which are a
// live view). Parsing/highlighting reuses the unified-diff machinery in git.ts;
// storage is the `patches` table (db.ts), cascade-deleted with the review.

import type { DiffFileChange, PatchDiff, PatchInfo } from "../shared/types.ts";
import { normalizeWs } from "./anchor.ts";
import * as db from "./db.ts";
import { blobSha, parseUnifiedDiff } from "./git.ts";
import { escapeHtml, highlightToLines, langForPath } from "./highlight.ts";

// Generous cap — patches live as TEXT rows in the global sqlite.
export const MAX_PATCH_BYTES = 10 * 1024 * 1024;

// Parse a raw patch into file changes, or null when nothing parses (not a
// unified diff / empty). The gate for every add path.
export function parsePatch(raw: string): DiffFileChange[] | null {
  const files = parseUnifiedDiff(raw);
  return files.length > 0 ? files : null;
}

// Highlight a parsed patch from its own hunk text. The originating refs may not
// exist anywhere (a piped diff, a rebased-away commit), so unlike the live-diff
// path there's no full file to read: reconstruct each side's visible text from
// the rows that carry that side's line numbers and highlight those pseudo-files.
// Multi-line constructs that span outside a hunk degrade gracefully (Shiki just
// sees less context). Cached by content sha like every other highlight.
async function highlightPatchFiles(files: DiffFileChange[], theme?: string): Promise<void> {
  await Promise.all(
    files.map(async (f) => {
      if (f.binary) return;
      const lang = langForPath(f.path);
      const oldRows: number[] = [];
      const newRows: number[] = [];
      f.lines.forEach((ln, i) => {
        if (ln.type === "hunk") return;
        if (ln.oldLine != null) oldRows.push(i);
        if (ln.newLine != null) newRows.push(i);
      });
      const hl = async (rowIdx: number[]) => {
        if (!rowIdx.length) return null;
        const content = rowIdx.map((i) => f.lines[i].text).join("\n");
        return highlightToLines(content, lang, await blobSha(content), theme);
      };
      const [oldHl, newHl] = await Promise.all([hl(oldRows), hl(newRows)]);
      // Map back by row order (the k-th new-side row is the k-th pseudo-file
      // line), preferring the new side like the live-diff renderer.
      const bySide = (rowIdx: number[], html: string[] | null) => {
        if (!html) return;
        rowIdx.forEach((rowI, k) => {
          const ln = f.lines[rowI];
          if (!ln.html) ln.html = html[k] ?? escapeHtml(ln.text);
        });
      };
      bySide(newRows, newHl);
      bySide(oldRows, oldHl);
      for (const ln of f.lines) {
        if (ln.type !== "hunk" && !ln.html) ln.html = escapeHtml(ln.text);
      }
    }),
  );
}

// All of a review's rounds, rendered (GET /api/reviews/:id/diff for stored
// reviews). Order is seq ascending — oldest round first, like reading history.
export async function renderPatches(reviewId: string, theme?: string): Promise<PatchDiff[]> {
  const out: PatchDiff[] = [];
  for (const p of db.listPatches(reviewId)) {
    const files = parseUnifiedDiff(p.body);
    await highlightPatchFiles(files, theme);
    out.push({ seq: p.seq, label: p.label, summary: p.summary, created_at: p.created_at, files });
  }
  return out;
}

// Meta + cheap stats for every round (GET …/patches, `r3 diff list`).
export function patchInfos(reviewId: string): PatchInfo[] {
  return db.listPatches(reviewId).map((p) => {
    const files = parseUnifiedDiff(p.body);
    return {
      seq: p.seq,
      label: p.label,
      summary: p.summary,
      created_at: p.created_at,
      files: files.map((f) => f.path),
      additions: files.reduce((n, f) => n + f.additions, 0),
      deletions: files.reduce((n, f) => n + f.deletions, 0),
    };
  });
}

// Validate a reply pin against the stored round it names: the round
// must exist, the file must appear in it, and a quote (its first line, matched
// whitespace-insensitively) must occur in that file's rows. Rounds are
// immutable, so passing once means the pin is valid forever. Returns an error
// string for a 400, or null when the pin holds up.
export function validateReplyPin(
  reviewId: string,
  pin: { patchSeq: number; file?: string | null; quote?: string | null },
): string | null {
  const patch = db.getPatch(reviewId, pin.patchSeq);
  if (!patch) return `no diff ${pin.patchSeq} in this review (see r3 diff list)`;
  if (!pin.file) return null;
  const files = parseUnifiedDiff(patch.body);
  const f = files.find((x) => x.path === pin.file || x.oldPath === pin.file);
  if (!f) return `diff ${pin.patchSeq} doesn't touch ${pin.file}`;
  if (!pin.quote) return null;
  const first = normalizeWs(pin.quote.split("\n", 1)[0]);
  if (!first) return null;
  const hit = f.lines.some((ln) => ln.type !== "hunk" && normalizeWs(ln.text).includes(first));
  return hit ? null : `quote not found in diff ${pin.patchSeq} ${pin.file}`;
}
