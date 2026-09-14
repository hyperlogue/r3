// Regroup captured patch rows without reconstructing or reading a source tree.
import type { DiffLine } from "../shared/types.ts";

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
// hunk-rows precondition ensures a headerless input still receives headers.
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
  // A full-context request short-circuits: nothing can be dropped, so skip the scan
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
      // a sufficiently large captured hunk would exceed the argument limit.
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
