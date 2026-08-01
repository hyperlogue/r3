// Expand-context: turning a diff's collapsed gaps into revealed rows.
//
// The server renders a diff at 3 lines of context but may HOLD more (a round
// captured wide, or a snapshot diff where it owns both full contents). It says so
// on each hunk row via `expandable`: `up` is the gap above that hunk, `down` the
// gap below it — the latter set on the last hunk of each contiguous run, since
// within a run every other downward gap is the next hunk's `up`. Anything the
// server doesn't hold is reported as 0, so a legacy or piped round has no gaps at
// all and the view shows the plain `@@` separator it always did.
//
// Revealed rows are merged back into ONE row list here, and DiffView derives
// everything from that merged list — the per-side text maps, the row-index maps,
// the split pairing, the virtualizer's count. That matters for correctness, not
// just tidiness: the gutter's quote assembly skips lines it can't find text for
// (gutter.ts), so a drag across rows that were revealed but not merged would
// silently produce a quote with lines missing — the exact mis-anchor this feature
// is supposed to make impossible.

import { type DiffLine, MAX_CONTEXT_ROWS } from "./types.ts";

// Lines revealed per click of a chevron. The whole gap is one click on the label.
export const EXPAND_STEP = 20;

// The per-request row ceiling comes from the contract (shared/types.ts), so
// "show all" on a huge gap asks for exactly what the route will serve — reveal
// in bites rather than issue a request that 400s and looks like a dead control.
// Deliberately not a second literal: the two would drift apart silently.

export interface Gap {
  // Stable identity for this gap's reveal state: `u<i>` / `d<i>`, where i is the
  // hunk row's index in the server's row list. One hunk can own both.
  key: string;
  // The row index this gap attaches to, and which side of it.
  hunkIndex: number;
  edge: "up" | "down";
  startNew: number; // first NEW-side line number hidden in this gap
  endNew: number; // last NEW-side line number hidden in this gap
}

export const gapSize = (g: Gap) => g.endNew - g.startNew + 1;

// Rows revealed for one gap, kept as two growing edges: `top` grows downward from
// the gap's first line, `bottom` grows upward from its last. They meet in the
// middle, at which point the gap is closed and its separator disappears.
export interface GapReveal {
  top: DiffLine[];
  bottom: DiffLine[];
}
export type RevealMap = Record<string, GapReveal | undefined>;

const revealedCount = (r: GapReveal | undefined) => (r ? r.top.length + r.bottom.length : 0);

// Every expandable gap in a file, in document order. Returns [] when the server
// reported nothing holdable — the common case for a legacy round, and what keeps
// the expander entirely absent rather than present-and-failing.
export function gapsOf(lines: DiffLine[]): Gap[] {
  const out: Gap[] = [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.type !== "hunk") continue;
    const up = ln.expandable?.up ?? 0;
    const down = ln.expandable?.down ?? 0;
    // The up-gap sits immediately above this hunk's first NEW-side row; the
    // down-gap immediately below its last. A hunk with no new side at all (a
    // pure deletion) can't be positioned this way and simply gets no expander.
    if (up > 0) {
      const firstNew = firstNewIn(lines, i);
      if (firstNew != null) {
        out.push({
          key: `u${i}`,
          hunkIndex: i,
          edge: "up",
          startNew: firstNew - up,
          endNew: firstNew - 1,
        });
      }
    }
    if (down > 0) {
      const lastNew = lastNewIn(lines, i);
      if (lastNew != null) {
        out.push({
          key: `d${i}`,
          hunkIndex: i,
          edge: "down",
          startNew: lastNew + 1,
          endNew: lastNew + down,
        });
      }
    }
  }
  return out;
}

// First / last NEW-side line of the hunk beginning at `from` (its content runs
// until the next hunk row or the end of the list).
function firstNewIn(lines: DiffLine[], from: number): number | null {
  for (let i = from + 1; i < lines.length && lines[i].type !== "hunk"; i++) {
    if (lines[i].newLine != null) return lines[i].newLine;
  }
  return null;
}
function lastNewIn(lines: DiffLine[], from: number): number | null {
  let last: number | null = null;
  for (let i = from + 1; i < lines.length && lines[i].type !== "hunk"; i++) {
    if (lines[i].newLine != null) last = lines[i].newLine;
  }
  return last;
}

// The NEW-side range one click should fetch. `edge` picks which end of the gap
// grows: "bottom" reveals the lines nearest the following code, "top" the lines
// nearest the preceding code, and "all" takes whatever is left — clamped to
// MAX_CONTEXT_ROWS, so a huge gap reveals in server-sized bites rather than
// issuing a request the route refuses.
export function rangeFor(
  gap: Gap,
  reveal: GapReveal | undefined,
  edge: "top" | "bottom" | "all",
): { start: number; end: number } | null {
  const lo = gap.startNew + (reveal?.top.length ?? 0);
  const hi = gap.endNew - (reveal?.bottom.length ?? 0);
  if (lo > hi) return null; // already closed
  if (edge === "all") return { start: lo, end: Math.min(hi, lo + MAX_CONTEXT_ROWS - 1) };
  if (edge === "top") return { start: lo, end: Math.min(hi, lo + EXPAND_STEP - 1) };
  return { start: Math.max(lo, hi - EXPAND_STEP + 1), end: hi };
}

export interface MergedLines {
  lines: DiffLine[];
  // Which gap a rendered hunk row stands for, and how much of it is still
  // hidden. Keyed by row IDENTITY: merge clones each separator so its remaining
  // count is current, and the renderer looks the row up here rather than
  // threading indices through the virtualizer.
  gapFor: Map<DiffLine, { gap: Gap; hidden: number }>;
}

// Are two consecutive rows adjacent in the FILE? Compare only the sides both
// carry — within a change block a del (no new side) is followed by an add (no old
// side), which shares no side and is correctly treated as adjacent.
function fileAdjacent(a: DiffLine, b: DiffLine): boolean {
  if (a.oldLine != null && b.oldLine != null && b.oldLine !== a.oldLine + 1) return false;
  if (a.newLine != null && b.newLine != null && b.newLine !== a.newLine + 1) return false;
  return true;
}

// Splice revealed rows back into the server's row list. A gap whose two edges
// have met loses its separator, so a fully-expanded region reads as one
// continuous run — but only where it really is continuous: `sealSeams` below puts
// an inert marker back wherever the code still jumps.
export function mergeRevealed(lines: DiffLine[], gaps: Gap[], reveal: RevealMap): MergedLines {
  const up = new Map<number, Gap>();
  const down = new Map<number, Gap>();
  for (const g of gaps) (g.edge === "up" ? up : down).set(g.hunkIndex, g);

  const out: DiffLine[] = [];
  const gapFor = new Map<DiffLine, { gap: Gap; hidden: number }>();

  const emitGap = (gap: Gap, separator: DiffLine | null) => {
    const r = reveal[gap.key];
    const hidden = gapSize(gap) - revealedCount(r);
    if (r) out.push(...r.top);
    if (hidden > 0) {
      // Clone so the separator's identity is unique per render pass and its
      // reported remaining count can't go stale.
      const row: DiffLine = separator ? { ...separator } : blankHunk();
      gapFor.set(row, { gap, hidden });
      out.push(row);
    }
    if (r) out.push(...r.bottom);
  };

  // The down-gap of hunk H is emitted once H's content ends — i.e. just before
  // the next hunk row, or at the end of the file.
  let pendingDown: Gap | undefined;
  const flushDown = () => {
    if (pendingDown) emitGap(pendingDown, null);
    pendingDown = undefined;
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.type === "hunk") {
      flushDown();
      const u = up.get(i);
      if (u) emitGap(u, ln);
      else out.push(ln);
      pendingDown = down.get(i);
      continue;
    }
    out.push(ln);
  }
  flushDown();

  return { lines: sealSeams(out), gapFor };
}

function blankHunk(): DiffLine {
  return { type: "hunk", oldLine: null, newLine: null, html: "", text: "" };
}

// Put an inert separator back wherever two adjacent rows aren't contiguous in the
// file. Closing a gap removes its separator, but "the server holds nothing more
// here" is NOT the same as "the code is continuous here": a body captured with
// gaps (a trimmed round whose change clusters sit far apart) has stretches that
// were never captured at all. Without this, expanding both sides of such a seam
// would butt line 23 against line 100 with nothing between them — rendering a
// hole as if it were the file, which is precisely what the server's
// 404-rather-than-partial-fill rule exists to prevent.
function sealSeams(rows: DiffLine[]): DiffLine[] {
  const out: DiffLine[] = [];
  for (let i = 0; i < rows.length; i++) {
    const prev = out[out.length - 1];
    const cur = rows[i];
    if (prev && prev.type !== "hunk" && cur.type !== "hunk" && !fileAdjacent(prev, cur)) {
      const seam = blankHunk();
      seam.text = `⋯ ${seamCount(prev, cur)}not in this diff`;
      out.push(seam); // no gapFor entry ⇒ inert, no expander offered
    }
    out.push(cur);
  }
  return out;
}

// How many lines the seam spans, when we can say honestly. A boundary row that's
// a del (or an add) carries only one side, so if the two rows share no side the
// distance isn't computable — say "lines" with no number rather than print one
// derived from a missing value. An overstated count here would be its own small
// version of the misrepresentation this marker exists to prevent.
function seamCount(prev: DiffLine, cur: DiffLine): string {
  const span = (a: number | null | undefined, b: number | null | undefined) =>
    a != null && b != null ? b - a - 1 : null;
  const n = span(prev.newLine, cur.newLine) ?? span(prev.oldLine, cur.oldLine);
  return n != null && n > 0 ? `${n} lines ` : "lines ";
}
