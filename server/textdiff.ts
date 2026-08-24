// In-process line differ (Myers SES + prefix/suffix trim) → DiffFileChange.
// Per-line `html` is left empty; snapshots.ts fills it.

import type { DiffFileChange, DiffLine } from "../shared/types.ts";

const DEFAULT_CONTEXT = 3;

// "Drop nothing": every unchanged line is kept, so the result is the file's full
// row list grouped into one hunk per contiguous run. What the expand-context
// slicer diffs against — it needs the rows a normal render throws away.
export const FULL_CONTEXT = Number.MAX_SAFE_INTEGER;

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

// Myers shortest-edit-script over two line arrays, in document order.
// O((n+m)·d) in the number of edits, not O(n·m) in the file size — a 2k-line
// file whose first and last lines changed is d≈2, not a 4e6-cell matrix.
// Deletions are emitted before additions at a divergence (conventional diff
// ordering). Linear-space bisect kicks in if d grows past TRACE_D_MAX so a
// pair of huge unrelated files cannot retain O(d·(n+m)) V-snapshots.
const TRACE_D_MAX = 256;

function myersOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((_, j) => ({ type: "add" as const, oldIdx: -1, newIdx: j }));
  if (m === 0) return a.map((_, i) => ({ type: "del" as const, oldIdx: i, newIdx: -1 }));
  const traced = myersTrace(a, b);
  return traced ?? myersBisect(a, 0, n, b, 0, m);
}

function myersTrace(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max;
  const v = new Int32Array(2 * max + 1);
  v[off + 1] = 0;
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    if (d > TRACE_D_MAX) return null;
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) {
        x = v[off + k + 1];
      } else {
        x = v[off + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        trace.push(Int32Array.from(v));
        return backtrack(a, b, trace, off);
      }
    }
    trace.push(Int32Array.from(v));
  }
  return null;
}

function backtrack(a: string[], b: string[], trace: Int32Array[], off: number): Op[] {
  const ops: Op[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : v[off + prevK];
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ type: "eq", oldIdx: x, newIdx: y });
    }
    if (d === 0) break;
    if (down) {
      y--;
      ops.push({ type: "add", oldIdx: -1, newIdx: y });
    } else {
      x--;
      ops.push({ type: "del", oldIdx: x, newIdx: -1 });
    }
    x = prevX;
    y = prevY;
  }
  ops.reverse();
  return ops;
}

// Total front/reverse diagonal steps one myersBisect call may spend before it
// stops searching and reports "no commonality" for whatever span it is on. Myers
// is O((n+m)·D), so an ADVERSARIAL pair — two large wholly-different files, where
// D is n+m — is quadratic: 20k lines each measured ~12 s, 100k over 100 s, all of
// it blocking the daemon's only thread. Real content sits far below the budget (a
// 20k-line file with 541 scattered edits spends ~0.6M steps; a 5k-line file with
// half of it rewritten ~6M), and exhausting it degrades to the same coarse
// delete-all/add-all the old LCS matrix produced past MAX_DP_CELLS — a valid diff,
// just not a minimal one.
const MAX_BISECT_STEPS = 50_000_000;

// Linear-space Myers: meet-in-the-middle split, then recurse. Used when the
// greedy trace would retain too many V snapshots (a high-edit pair).
function myersBisect(
  a: string[],
  as: number,
  ae: number,
  b: string[],
  bs: number,
  be: number,
): Op[] {
  const ops: Op[] = [];
  let budget = MAX_BISECT_STEPS;
  walk(as, ae, bs, be);
  return ops;

  function walk(a0: number, a1: number, b0: number, b1: number): void {
    while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) {
      ops.push({ type: "eq", oldIdx: a0, newIdx: b0 });
      a0++;
      b0++;
    }
    let aEnd = a1;
    let bEnd = b1;
    while (aEnd > a0 && bEnd > b0 && a[aEnd - 1] === b[bEnd - 1]) {
      aEnd--;
      bEnd--;
    }
    const n = aEnd - a0;
    const m = bEnd - b0;
    if (n > 0 && m > 0) {
      const { x, y } = findSplit(a0, n, b0, m);
      if ((x === 0 && y === 0) || (x === n && y === m)) {
        for (let i = a0; i < aEnd; i++) ops.push({ type: "del", oldIdx: i, newIdx: -1 });
        for (let j = b0; j < bEnd; j++) ops.push({ type: "add", oldIdx: -1, newIdx: j });
      } else {
        walk(a0, a0 + x, b0, b0 + y);
        walk(a0 + x, aEnd, b0 + y, bEnd);
      }
    } else if (n > 0) {
      for (let i = a0; i < aEnd; i++) ops.push({ type: "del", oldIdx: i, newIdx: -1 });
    } else if (m > 0) {
      for (let j = b0; j < bEnd; j++) ops.push({ type: "add", oldIdx: -1, newIdx: j });
    }
    for (let i = aEnd, j = bEnd; i < a1; i++, j++) {
      ops.push({ type: "eq", oldIdx: i, newIdx: j });
    }
  }

  function findSplit(a0: number, n: number, b0: number, m: number): { x: number; y: number } {
    // Meet-in-the-middle: front and reverse D-paths, overlap is a point on an
    // optimal path. maxD is ceil((n+m)/2) because the two searches together
    // cover a full SES.
    //
    // Sizing + pruning are load-bearing, not defensive: `off + k` must be
    // addressable for every k in [-maxD, maxD] (hence 2*maxD+1, not 2*maxD —
    // skipping the extreme diagonal leaves holes in V that later reads take for
    // real positions), and a diagonal that walks off the grid must stop being
    // searched (fStart/fEnd/rStart/rEnd) or its overshoot poisons the frontier.
    // Get either wrong and the overlap is missed, findSplit falls through to the
    // {n,0} bail-out, and `walk` emits a delete-all/add-all for that span — a
    // valid but far-from-minimal diff.
    const maxD = Math.ceil((n + m) / 2);
    const off = maxD;
    const len = 2 * maxD + 1;
    const vf = new Int32Array(len).fill(-1);
    const vr = new Int32Array(len).fill(-1);
    vf[off + 1] = 0;
    vr[off + 1] = 0;
    const delta = n - m;
    const front = (delta & 1) !== 0;
    // How far the searched diagonal band has been trimmed at each end after a
    // path ran past the grid's right (x > n) or bottom (y > m) edge.
    let fStart = 0;
    let fEnd = 0;
    let rStart = 0;
    let rEnd = 0;
    for (let d = 0; d < maxD; d++) {
      if (budget <= 0) return { x: n, y: 0 };
      budget -= 2 * d + 2;
      for (let k = -d + fStart; k <= d - fEnd; k += 2) {
        const ki = off + k;
        // k === d never reads ki+1 and k === -d never reads ki-1 (short-circuit),
        // so both neighbours are in range and already written.
        let x: number;
        if (k === -d || (k !== d && vf[ki - 1] < vf[ki + 1])) {
          x = vf[ki + 1];
        } else {
          x = vf[ki - 1] + 1;
        }
        let y = x - k;
        while (x < n && y < m && a[a0 + x] === b[b0 + y]) {
          x++;
          y++;
        }
        vf[ki] = x;
        if (x > n) fEnd += 2;
        else if (y > m) fStart += 2;
        else if (front) {
          const ri = off + delta - k;
          if (ri >= 0 && ri < len && vr[ri] !== -1 && x >= n - vr[ri]) return { x, y };
        }
      }
      for (let k = -d + rStart; k <= d - rEnd; k += 2) {
        const ki = off + k;
        let x: number;
        if (k === -d || (k !== d && vr[ki - 1] < vr[ki + 1])) {
          x = vr[ki + 1];
        } else {
          x = vr[ki - 1] + 1;
        }
        let y = x - k;
        while (x < n && y < m && a[a0 + n - x - 1] === b[b0 + m - y - 1]) {
          x++;
          y++;
        }
        vr[ki] = x;
        if (x > n) rEnd += 2;
        else if (y > m) rStart += 2;
        else if (!front) {
          const fi = off + delta - k;
          if (fi >= 0 && fi < len && vf[fi] !== -1) {
            const xF = vf[fi];
            const yF = xF - (fi - off);
            if (xF >= n - x) return { x: xF, y: yF };
          }
        }
      }
    }
    // No overlap within maxD: the two sides share nothing.
    return { x: n, y: 0 };
  }
}

// Full edit script with a common-prefix/suffix fast path: equal head + tail lines
// are matched directly, so Myers only runs over the changed middle — the common
// case (a few edits in a large file) stays cheap. Indices are absolute.
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
  const mid = myersOps(
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
      // Not `out.push(...hunk)`: a spread passes every row as a call argument, so
      // a hunk past a few hundred thousand rows throws RangeError — two large
      // wholly-different files become one run and renderSnapshotContext rehunks
      // at FULL_CONTEXT.
      for (const row of hunk) out.push(row);
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
