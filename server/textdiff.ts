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

  // Merge changed regions with their surrounding context into hunks: an eq run
  // longer than 2·context splits hunks; anything shorter stays inside one.
  const keep = ops.map((o) => o.type !== "eq");
  const n = ops.length;
  for (let idx = 0; idx < n; idx++) {
    if (ops[idx].type !== "eq") continue;
    // Distance to the nearest change on either side.
    let left = Infinity;
    for (let k = idx - 1; k >= 0 && idx - k <= context; k--) {
      if (ops[k].type !== "eq") {
        left = idx - k;
        break;
      }
    }
    let right = Infinity;
    for (let k = idx + 1; k < n && k - idx <= context; k++) {
      if (ops[k].type !== "eq") {
        right = k - idx;
        break;
      }
    }
    if (left <= context || right <= context) keep[idx] = true;
  }

  const lines: DiffLine[] = [];
  let additions = 0;
  let deletions = 0;
  let h = 0;
  while (h < n) {
    if (!keep[h]) {
      h++;
      continue;
    }
    // Collect a maximal run of kept ops into one hunk.
    let end = h;
    while (end < n && keep[end]) end++;
    const hunk = ops.slice(h, end);
    let oldStart = 0;
    let newStart = 0;
    let oldCount = 0;
    let newCount = 0;
    for (const op of hunk) {
      if (op.oldIdx >= 0) {
        if (oldCount === 0) oldStart = op.oldIdx + 1;
        oldCount++;
      }
      if (op.newIdx >= 0) {
        if (newCount === 0) newStart = op.newIdx + 1;
        newCount++;
      }
    }
    lines.push(row("hunk", null, null, `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`));
    for (const op of hunk) {
      if (op.type === "eq") {
        lines.push(row("context", op.oldIdx + 1, op.newIdx + 1, oldLines[op.oldIdx]));
      } else if (op.type === "del") {
        deletions++;
        lines.push(row("del", op.oldIdx + 1, null, oldLines[op.oldIdx]));
      } else {
        additions++;
        lines.push(row("add", null, op.newIdx + 1, newLines[op.newIdx]));
      }
    }
    h = end;
  }

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
