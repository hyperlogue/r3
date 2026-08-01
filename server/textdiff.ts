// In-process line diff (files-review snapshots). Produces a
// `DiffFileChange` for one file from its old/new *full content* — the same shape
// `parseUnifiedDiff` emits from `git diff`, so `DiffView` renders it unchanged.
// This is how a files review's snapshot→snapshot (or snapshot→live) diff is
// derived: the daemon owns both full contents, so it can diff them itself, with
// no git and no temp files (which matters for scratch reviews outside any repo).
// Per-line `html` is left empty here; the caller (snapshots.ts) fills it by
// highlighting each side from the full contents (accurate multi-line context).

import type { DiffFileChange, DiffLine } from "../shared/types.ts";

const DEFAULT_CONTEXT = 3;

// Above this old×new product the exact LCS is skipped for a coarse
// "delete-all-then-add-all" diff — a backstop against a pathological pair blowing
// out the O(n·m) DP. Real design docs / code files sit far below it, and the
// prefix/suffix trim below shrinks the DP to just the changed middle anyway.
const MAX_DP_CELLS = 4_000_000;

// Split content into lines the way a diff sees them: a single trailing newline is
// the end-of-file marker, not an empty final line, so "a\nb\n" is ["a","b"].
// Consequence: a change that only flips the file's trailing-newline state ("a\nb"
// vs "a\nb\n") normalizes to the same lines on both sides and so is invisible to
// this differ — git would surface it as a "\ No newline at end of file" marker,
// but we have no equivalent. Acceptable for the files-review snapshot use.
export function toDiffLines(content: string): string[] {
  if (content === "") return [];
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  return body.split("\n");
}

type OpType = "eq" | "del" | "add";
interface Op {
  type: OpType;
  oldIdx: number; // 0-based index into old lines, or -1
  newIdx: number; // 0-based index into new lines, or -1
}

// Longest-common-subsequence edit script over two line arrays, in document order.
// Standard O(n·m) DP + backtrack; deletions are emitted before additions at a
// divergence (the conventional diff ordering).
function lcsOps(a: string[], b: string[]): Op[] {
  const m = a.length;
  const n = b.length;
  if (m === 0) return b.map((_, j) => ({ type: "add" as const, oldIdx: -1, newIdx: j }));
  if (n === 0) return a.map((_, i) => ({ type: "del" as const, oldIdx: i, newIdx: -1 }));
  if (m * n > MAX_DP_CELLS) {
    return [
      ...a.map((_, i) => ({ type: "del" as const, oldIdx: i, newIdx: -1 })),
      ...b.map((_, j) => ({ type: "add" as const, oldIdx: -1, newIdx: j })),
    ];
  }
  // dp[i][j] = LCS length of a[i:] and b[j:]. Sized (m+1)×(n+1), last row/col 0.
  const dp: Uint32Array[] = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--) {
    const row = dp[i];
    const next = dp[i + 1];
    for (let j = n - 1; j >= 0; j--) {
      row[j] = a[i] === b[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ type: "eq", oldIdx: i, newIdx: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "del", oldIdx: i, newIdx: -1 });
      i++;
    } else {
      ops.push({ type: "add", oldIdx: -1, newIdx: j });
      j++;
    }
  }
  while (i < m) ops.push({ type: "del", oldIdx: i++, newIdx: -1 });
  while (j < n) ops.push({ type: "add", oldIdx: -1, newIdx: j++ });
  return ops;
}

// Full edit script with a common-prefix/suffix fast path: equal head + tail lines
// are matched directly, so the O(n·m) DP only runs over the changed middle — the
// common case (a few edits in a large file) stays cheap. Indices are absolute.
function diffOps(oldLines: string[], newLines: string[]): Op[] {
  let p = 0;
  while (p < oldLines.length && p < newLines.length && oldLines[p] === newLines[p]) p++;
  let s = 0;
  while (
    s < oldLines.length - p &&
    s < newLines.length - p &&
    oldLines[oldLines.length - 1 - s] === newLines[newLines.length - 1 - s]
  )
    s++;

  const ops: Op[] = [];
  for (let i = 0; i < p; i++) ops.push({ type: "eq", oldIdx: i, newIdx: i });
  const mid = lcsOps(
    oldLines.slice(p, oldLines.length - s),
    newLines.slice(p, newLines.length - s),
  );
  for (const op of mid) {
    ops.push({
      type: op.type,
      oldIdx: op.oldIdx >= 0 ? op.oldIdx + p : -1,
      newIdx: op.newIdx >= 0 ? op.newIdx + p : -1,
    });
  }
  const oldTail = oldLines.length - s;
  const newTail = newLines.length - s;
  for (let k = 0; k < s; k++) ops.push({ type: "eq", oldIdx: oldTail + k, newIdx: newTail + k });
  return ops;
}

const row = (
  type: DiffLine["type"],
  oldLine: number | null,
  newLine: number | null,
  text: string,
): DiffLine => ({
  type,
  oldLine,
  newLine,
  html: "",
  text,
});

// Are two consecutive rows adjacent in the FILE (not merely in the array)? Rows
// parsed out of a `-U3` patch jump across hunk gaps, so array order alone would
// happily merge lines 12 and 50 into one hunk. Compare only the sides both rows
// carry: within a change block a del (new = null) is followed by an add
// (old = null), which shares no side and is correctly treated as adjacent.
function fileAdjacent(a: DiffLine, b: DiffLine): boolean {
  if (a.oldLine != null && b.oldLine != null && b.oldLine !== a.oldLine + 1) return false;
  if (a.newLine != null && b.newLine != null && b.newLine !== a.newLine + 1) return false;
  return true;
}

// Regroup a row list into hunks holding up to `context` unchanged lines around
// each change, dropping the context beyond that and regenerating the `@@`
// headers. The inverse of "capture wide": a round is STORED with generous
// context so it can be expanded later, and rendered narrow so the default
// payload stays the size it is today.
//
// Existing hunk rows are discarded and recomputed. Rows that aren't file-adjacent
// (a gap the stored patch never carried) can never be merged into one hunk — the
// lines simply aren't there — so each contiguous run is regrouped on its own.
//
// Returns the input UNCHANGED when nothing would be dropped AND it already
// carries hunk rows. That keeps a legacy `-U3` round byte-identical through a
// render, including git's `@@ … @@ section heading` text, which regenerating
// headers would otherwise throw away on every request for no gain. The
// hunk-rows precondition matters: `diffFile` passes a header-less row list and
// always needs headers emitted, however little gets dropped.
export function rehunk(lines: DiffLine[], context: number): DiffLine[] {
  const rows = lines.filter((ln) => ln.type !== "hunk");
  if (rows.length === 0) return lines;
  const hadHeaders = rows.length !== lines.length;

  // Contiguous runs: [start, end) index pairs into `rows`.
  const runs: [number, number][] = [];
  let runStart = 0;
  for (let i = 1; i < rows.length; i++) {
    if (!fileAdjacent(rows[i - 1], rows[i])) {
      runs.push([runStart, i]);
      runStart = i;
    }
  }
  runs.push([runStart, rows.length]);

  // Keep every change, plus any context row within `context` of one. Index
  // distance is valid here because it's measured inside a contiguous run.
  const keep = rows.map((r) => r.type !== "context");
  for (const [lo, hi] of runs) {
    for (let idx = lo; idx < hi; idx++) {
      if (rows[idx].type !== "context") continue;
      let near = false;
      for (let k = idx - 1; k >= lo && idx - k <= context; k--) {
        if (rows[k].type !== "context") {
          near = true;
          break;
        }
      }
      if (!near) {
        for (let k = idx + 1; k < hi && k - idx <= context; k++) {
          if (rows[k].type !== "context") {
            near = true;
            break;
          }
        }
      }
      if (near) keep[idx] = true;
    }
  }
  if (hadHeaders && keep.every(Boolean)) return lines;

  const out: DiffLine[] = [];
  for (const [lo, hi] of runs) {
    let h = lo;
    while (h < hi) {
      if (!keep[h]) {
        h++;
        continue;
      }
      let end = h;
      while (end < hi && keep[end]) end++;
      out.push(...hunkFrom(rows.slice(h, end)));
      h = end;
    }
  }
  return out;
}

// One hunk: its `@@` header followed by its rows. A hunk with no rows on a side
// (a pure insertion into an empty file) reports start 0 there, matching git.
function hunkFrom(hunk: DiffLine[]): DiffLine[] {
  let oldStart = 0;
  let newStart = 0;
  let oldCount = 0;
  let newCount = 0;
  for (const r of hunk) {
    if (r.oldLine != null) {
      if (oldCount === 0) oldStart = r.oldLine;
      oldCount++;
    }
    if (r.newLine != null) {
      if (newCount === 0) newStart = r.newLine;
      newCount++;
    }
  }
  return [
    row("hunk", null, null, `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`),
    ...hunk,
  ];
}

// Diff one file from its old/new full content into a `DiffFileChange`, grouping
// changes into hunks with up to `context` unchanged lines around them (adjacent
// hunks whose context would touch are merged). Returns null when the contents are
// identical (an unchanged file is omitted from a diff). A null side means the file
// was added (oldContent null) or deleted (newContent null).
export function diffFile(
  path: string,
  oldContent: string | null,
  newContent: string | null,
  context = DEFAULT_CONTEXT,
): DiffFileChange | null {
  const oldLines = toDiffLines(oldContent ?? "");
  const newLines = toDiffLines(newContent ?? "");
  const ops = diffOps(oldLines, newLines);
  const changed = ops.filter((o) => o.type !== "eq").length;
  if (changed === 0) return null;

  // Every op as a row first, then let `rehunk` group them — the grouping rule is
  // shared with the stored-round path (patches.ts renders a wide body narrow with
  // the same function), so the two can't drift.
  const all: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.type === "eq") {
      all.push(row("context", op.oldIdx + 1, op.newIdx + 1, oldLines[op.oldIdx]));
    } else if (op.type === "del") {
      deletions++;
      all.push(row("del", op.oldIdx + 1, null, oldLines[op.oldIdx]));
    } else {
      additions++;
      all.push(row("add", null, op.newIdx + 1, newLines[op.newIdx]));
    }
  }
  const lines = rehunk(all, context);

  const status: DiffFileChange["status"] =
    oldContent == null ? "added" : newContent == null ? "deleted" : "modified";
  return {
    oldPath: status === "added" ? null : path,
    newPath: status === "deleted" ? null : path,
    path,
    status,
    binary: false,
    additions,
    deletions,
    lines,
  };
}
