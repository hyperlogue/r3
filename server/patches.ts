// Stored diff rounds: append-only immutable unified-diff patches. Parsing
// reuses git.ts; storage is the `patches` table.

import type { DiffFileChange, DiffLine, PatchDiff, PatchInfo } from "../shared/types.ts";
import { normalizeWs } from "./anchor.ts";
import * as db from "./db.ts";
import { blobSha, parseUnifiedDiff, trimOversizedFiles } from "./git.ts";
import { escapeHtml, highlightToLines, langForPath, resolveTheme } from "./highlight.ts";
import { rehunk } from "./textdiff.ts";

// Generous cap — patches live as TEXT rows in the global sqlite.
export const MAX_PATCH_BYTES = 10 * 1024 * 1024;

// What a render collapses to. The stored body is wide; the default payload is
// the same size it has always been.
export const RENDER_CONTEXT = 3;

// Last resort for a wide capture that's still over the storage cap after the
// per-file trim (a very large refactor: enough files each just under the per-file
// cap to add up past 10 MB). Re-trim the whole patch to render width — the round
// then stores what a pre-wide-capture r3 would have stored, so it's created
// successfully and simply can't expand, rather than being rejected outright.
export function fitPatchToLimit(raw: string): string {
  if (Buffer.byteLength(raw, "utf8") <= MAX_PATCH_BYTES) return raw;
  // cap 0 = trim every file, not just the oversized ones.
  return trimOversizedFiles(raw, RENDER_CONTEXT, 0);
}

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

// Rendered rounds, memoized on (review, seq, theme). A round is IMMUTABLE — the
// house rule is that changes arrive as new rounds, never as edits — so a stored
// (review, seq) always renders the same bytes. `diff rm` is the one exception
// (it can free a seq for reuse) and calls forgetRenderedRounds below.
//
// The SPA fetches one seq; the cache still pays for theme switches, stepping
// back to a visited round, and the omitted-seq all-rounds compat path. Budgeted
// in bytes of source, like the line cache, since a round's render is
// proportional to its stored body.
const ROUND_CACHE_MAX_BYTES = 8 * 1024 * 1024;
const roundCache = new Map<string, { cost: number; v: PatchDiff }>();
let roundCacheBytes = 0;

type PatchRow = {
  seq: number;
  label: string | null;
  summary: string | null;
  created_at: string;
  body: string;
};

function roundKey(reviewId: string, seq: number, theme?: string): string {
  return `${reviewId}:${seq}:${resolveTheme(theme).name}`;
}

function takeCached(key: string): PatchDiff | null {
  const hit = roundCache.get(key);
  if (!hit) return null;
  roundCache.delete(key); // LRU: re-insert to move to the newest slot.
  roundCache.set(key, hit);
  return hit.v;
}

async function cachedRound(reviewId: string, p: PatchRow, theme?: string): Promise<PatchDiff> {
  const key = roundKey(reviewId, p.seq, theme);
  const hit = takeCached(key);
  if (hit) return hit;
  const files = parseUnifiedDiff(p.body);
  // Collapse the stored (wide) context to the render width BEFORE highlighting:
  // Shiki then tokenizes the same ~3-context rows it always did, so a body
  // several times larger costs one linear text parse and nothing on the hot
  // path. A legacy -U3 round has nothing to drop and passes through untouched.
  for (const f of files) f.lines = rehunk(f.lines, RENDER_CONTEXT, { markExpandable: true });
  await highlightPatchFiles(files, theme);
  const v: PatchDiff = {
    seq: p.seq,
    label: p.label,
    summary: p.summary,
    created_at: p.created_at,
    files,
  };
  roundCache.set(key, { cost: p.body.length, v });
  roundCacheBytes += p.body.length;
  while (roundCacheBytes > ROUND_CACHE_MAX_BYTES && roundCache.size > 1) {
    const oldest = roundCache.keys().next().value;
    if (oldest === undefined) break;
    roundCacheBytes -= roundCache.get(oldest)?.cost ?? 0;
    roundCache.delete(oldest);
  }
  return v;
}

// One stored round, rendered (GET /api/reviews/:id/diff?seq=). Null if that seq
// isn't in the patches table — the route turns that into `{ rounds: [] }`.
export async function renderPatch(
  reviewId: string,
  seq: number,
  theme?: string,
): Promise<PatchDiff | null> {
  const hit = takeCached(roundKey(reviewId, seq, theme));
  if (hit) return hit;
  const patch = db.getPatch(reviewId, seq);
  return patch ? cachedRound(reviewId, patch, theme) : null;
}

// All of a review's rounds, rendered (GET /api/reviews/:id/diff with seq omitted
// — compat for curl/old clients). Order is seq ascending — oldest first.
export async function renderPatches(reviewId: string, theme?: string): Promise<PatchDiff[]> {
  const out: PatchDiff[] = [];
  for (const p of db.listPatches(reviewId)) out.push(await cachedRound(reviewId, p, theme));
  return out;
}

// Drop a review's cached renders. Required for `diff rm`: addPatch allocates
// MAX(seq)+1 over patches ∪ feedback.patch_seq ∪ replies.patch_seq, so removing
// the highest round with nothing referencing it lets that seq be handed out
// again with a DIFFERENT body — the one case where the key could go stale.
export function forgetRenderedRounds(reviewId: string): void {
  for (const key of [...roundCache.keys()])
    if (key.startsWith(`${reviewId}:`)) {
      roundCacheBytes -= roundCache.get(key)?.cost ?? 0;
      roundCache.delete(key);
    }
}

// Serve a slice of a stored round's held-but-not-rendered context: the rows
// whose NEW-side line numbers fall in [start,end] for one file. Backs the diff
// view's expand-context gaps.
//
// Only unchanged rows are servable. A range that isn't fully covered by held
// context returns null (404) rather than a partial fill — the client asked for a
// gap the round doesn't have, and silently returning less would leave a hole the
// UI would render as if it were the file. Highlighted from the same per-side
// pseudo-files the round itself uses, so the revealed rows match their
// neighbours.
export async function renderPatchContext(
  reviewId: string,
  seq: number,
  file: string,
  start: number,
  end: number,
  theme?: string,
): Promise<DiffLine[] | null> {
  const patch = db.getPatch(reviewId, seq);
  if (!patch) return null;
  const f = parseUnifiedDiff(patch.body).find((x) => x.path === file || x.oldPath === file);
  if (!f) return null;
  const rows = f.lines.filter(
    (ln) => ln.type === "context" && ln.newLine != null && ln.newLine >= start && ln.newLine <= end,
  );
  if (rows.length !== end - start + 1) return null;
  // Highlight the slice against the whole new side, so multi-line constructs
  // colorize with the context they actually have.
  const lang = langForPath(f.path);
  const newRows = f.lines.filter((ln) => ln.type !== "hunk" && ln.newLine != null);
  const content = newRows.map((ln) => ln.text).join("\n");
  const hl = await highlightToLines(content, lang, await blobSha(content), theme);
  const indexOfNew = new Map(newRows.map((ln, i) => [ln.newLine, i]));
  return rows.map((ln) => ({
    ...ln,
    html: hl?.[indexOfNew.get(ln.newLine) ?? -1] ?? escapeHtml(ln.text),
  }));
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
  pin: {
    patchSeq: number;
    file?: string | null;
    lineStart?: number | null;
    lineEnd?: number | null;
    quote?: string | null;
  },
): string | null {
  const patch = db.getPatch(reviewId, pin.patchSeq);
  if (!patch) return `no diff ${pin.patchSeq} in this review (see r3 diff list)`;
  if (!pin.file) return null;
  const files = parseUnifiedDiff(patch.body);
  const f = files.find((x) => x.path === pin.file || x.oldPath === pin.file);
  if (!f) return `diff ${pin.patchSeq} doesn't touch ${pin.file}`;
  // A pin names the NEW side — where the fix landed — so check the range against
  // the rows carrying new-side numbers. Against the FULL stored body, not the
  // rehunked render, so a line inside an expandable region still validates. A
  // file the round only deletes has no new side, so there's nothing to check.
  const newRows = f.lines.filter((ln) => ln.type !== "hunk" && ln.newLine != null);
  if (pin.lineStart != null && newRows.length) {
    const lo = pin.lineStart;
    const hi = pin.lineEnd ?? lo;
    const have = new Set(newRows.map((ln) => ln.newLine as number));
    for (let n = lo; n <= hi; n++)
      if (!have.has(n))
        return `L${lo}${hi !== lo ? `-${hi}` : ""} isn't in diff ${pin.patchSeq} for ${pin.file} — pin lines the round shows`;
  }
  if (!pin.quote) return null;
  const first = normalizeWs(pin.quote.split("\n", 1)[0]);
  if (!first) return null;
  const hit = f.lines.some((ln) => ln.type !== "hunk" && normalizeWs(ln.text).includes(first));
  return hit ? null : `quote not found in diff ${pin.patchSeq} ${pin.file}`;
}
