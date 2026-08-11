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

// "Drop nothing": every unchanged line is kept, so the result is the file's full
// row list grouped into one hunk per contiguous run. What the expand-context
// slicer diffs against — it needs the rows a normal render throws away.
export const FULL_CONTEXT = Number.MAX_SAFE_INTEGER;

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
// (old = null), which shares no side.
//
// Sharing no side proves nothing on its own, though — a hunk ending in a del
// followed by a hunk starting with an add is the same shape as one change block,
// so the rows alone cannot tell them apart. The `@@` row that sat between them
// is the evidence, and `hunkBetween` carries it: a patch that wrote a header
// there is a patch that jumped a gap it never captured.
function fileAdjacent(a: DiffLine, b: DiffLine, hunkBetween: boolean): boolean {
  let shared = false;
  if (a.oldLine != null && b.oldLine != null) {
    if (b.oldLine !== a.oldLine + 1) return false;
    shared = true;
  }
  if (a.newLine != null && b.newLine != null) {
    if (b.newLine !== a.newLine + 1) return false;
    shared = true;
  }
  return shared ? true : !hunkBetween;
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
export function rehunk(
  lines: DiffLine[],
  context: number,
  // Tag each emitted hunk row with how many rows the caller still HOLDS around
  // it (see DiffLine.expandable). Only meaningful when `lines` is the full body:
  // it reports what this row list contains, which is exactly what a gap-fill
  // request can serve back.
  opts: { markExpandable?: boolean } = {},
): DiffLine[] {
  // Drop the hunk rows, but remember where they were: `hunkBefore[i]` says a
  // `@@` header stood immediately before rows[i], which is the only evidence
  // that a del/add pair spans a gap rather than one change block (fileAdjacent).
  const rows: DiffLine[] = [];
  const hunkBefore: boolean[] = [];
  let sawHunk = false;
  for (const ln of lines) {
    if (ln.type === "hunk") {
      sawHunk = true;
      continue;
    }
    rows.push(ln);
    hunkBefore.push(sawHunk);
    sawHunk = false;
  }
  if (rows.length === 0) return lines;
  const hadHeaders = rows.length !== lines.length;

  // Contiguous runs: [start, end) index pairs into `rows`.
  const runs: [number, number][] = [];
  let runStart = 0;
  for (let i = 1; i < rows.length; i++) {
    if (!fileAdjacent(rows[i - 1], rows[i], hunkBefore[i])) {
      runs.push([runStart, i]);
      runStart = i;
    }
  }
  runs.push([runStart, rows.length]);

  // Keep every change, plus any context row within `context` of one. Index
  // distance is valid here because it's measured inside a contiguous run.
  // FULL_CONTEXT short-circuits: nothing can be dropped, so skip the scan
  // entirely rather than letting each row search the whole run for a change.
  const keepAll = context >= rows.length;
  const keep = rows.map((r) => keepAll || r.type !== "context");
  for (const [lo, hi] of keepAll ? [] : runs) {
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
  // Emitted hunks in order, as [firstRowIdx, lastRowIdx] into `rows`, so the
  // gap before each one (and after the last) can be measured below.
  const emitted: { header: DiffLine; from: number; to: number; run: number }[] = [];
  for (let r = 0; r < runs.length; r++) {
    const [lo, hi] = runs[r];
    let h = lo;
    while (h < hi) {
      if (!keep[h]) {
        h++;
        continue;
      }
      let end = h;
      while (end < hi && keep[end]) end++;
      const hunk = hunkFrom(rows.slice(h, end));
      emitted.push({ header: hunk[0], from: h, to: end - 1, run: r });
      out.push(...hunk);
      h = end;
    }
  }

  if (opts.markExpandable) {
    for (let i = 0; i < emitted.length; i++) {
      const cur = emitted[i];
      const prev = emitted[i - 1];
      const next = emitted[i + 1];
      const [runLo, runHi] = runs[cur.run];
      // Held rows are bounded by the CONTIGUOUS RUN, not the array: rows in a
      // different run sit across a gap the patch never captured, so they can't
      // be offered. Within a run everything between two hunks is held.
      const lowerBound = prev && prev.run === cur.run ? prev.to + 1 : runLo;
      const up = cur.from - lowerBound;
      // A downward gap is reported by the last hunk OF ITS RUN — not just the
      // file's last hunk. Within a run every other downward gap is the next
      // hunk's `up` and would be double-counted, but a run's tail is reported by
      // nobody else: the next hunk belongs to a different run and its `up` is 0.
      // A body has several runs whenever capture itself had gaps (a file trimmed
      // to -U25 with change clusters far apart — exactly what the trim targets),
      // so keying this on the file would strand those rows unreachable.
      const down = !next || next.run !== cur.run ? runHi - 1 - cur.to : 0;
      if (up > 0 || down > 0) cur.header.expandable = { up, down };
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
  // `all` is the complete row list, so the held-context counts are always
  // accurate here — a snapshot diff can expand from day one, with no capture
  // policy involved: the daemon owns both full contents.
  const lines = rehunk(all, context, { markExpandable: true });

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
