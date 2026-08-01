// Expand-context: turning a diff's collapsed gaps into revealed rows.
//
// The server renders a diff at 3 lines of context but may HOLD more (a round
// captured wide, or a snapshot diff where it owns both full contents). It says so
// on each hunk row via `expandable` — `up` is the gap above that hunk, and `down`
// is non-zero only on the last hunk, covering the file's trailing lines. Anything
// it doesn't hold is reported as 0, so a legacy or piped round simply has no gaps
// and the view shows the plain `@@` separator it always did.
//
// Revealed rows are merged back into ONE row list here, and DiffView derives
// everything from that merged list — the per-side text maps, the row-index maps,
// the split pairing, the virtualizer's count. That matters for correctness, not
// just tidiness: the gutter's quote assembly skips lines it can't find text for
// (gutter.ts), so a drag across rows that were revealed but not merged would
// silently produce a quote with lines missing — the exact mis-anchor this feature
// is supposed to make impossible.

import type { DiffLine } from "./types.ts";

// Lines revealed per click of a chevron. The whole gap is one click on the label.
export const EXPAND_STEP = 20;

// Key of the synthetic gap after a file's last hunk. Real gaps are keyed by their
// hunk row's index in the server's row list; the trailing gap has no row of its
// own (hunk rows only ever precede a hunk), so the client synthesizes one.
export const TRAILING_GAP = -1;

export interface Gap {
  key: number; // hunk row index in the source lines, or TRAILING_GAP
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
export type RevealMap = Record<number, GapReveal | undefined>;

const revealed = (r: GapReveal | undefined) => (r ? r.top.length + r.bottom.length : 0);

// Every expandable gap in a file, in document order. Returns [] when the server
// reported nothing holdable — the common case for a legacy round, and what keeps
// the expander entirely absent rather than present-and-failing.
export function gapsOf(lines: DiffLine[]): Gap[] {
  const out: Gap[] = [];
  let lastHunk = -1;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (ln.type !== "hunk") continue;
    lastHunk = i;
    const up = ln.expandable?.up ?? 0;
    if (up <= 0) continue;
    // The gap sits immediately above this hunk's first NEW-side row. A hunk with
    // no new side at all (a pure deletion) can't be positioned this way, so it
    // simply gets no expander.
    const firstNew = firstNewAfter(lines, i);
    if (firstNew == null) continue;
    out.push({ key: i, startNew: firstNew - up, endNew: firstNew - 1 });
  }
  const down = lastHunk >= 0 ? (lines[lastHunk].expandable?.down ?? 0) : 0;
  if (down > 0) {
    const lastNew = lastNewLine(lines);
    if (lastNew != null) {
      out.push({ key: TRAILING_GAP, startNew: lastNew + 1, endNew: lastNew + down });
    }
  }
  return out;
}

function firstNewAfter(lines: DiffLine[], from: number): number | null {
  for (let i = from + 1; i < lines.length; i++) {
    if (lines[i].type === "hunk") return null; // empty hunk — nothing to anchor to
    if (lines[i].newLine != null) return lines[i].newLine;
  }
  return null;
}

function lastNewLine(lines: DiffLine[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].type !== "hunk" && lines[i].newLine != null) return lines[i].newLine;
  }
  return null;
}

// The NEW-side range one click should fetch. `edge` picks which end of the gap
// grows: "bottom" reveals the lines just above the following hunk (nearest the
// code you're reading), "top" the lines just below the preceding one, and "all"
// takes whatever is left in one go.
export function rangeFor(
  gap: Gap,
  reveal: GapReveal | undefined,
  edge: "top" | "bottom" | "all",
): { start: number; end: number } | null {
  const topLen = reveal?.top.length ?? 0;
  const botLen = reveal?.bottom.length ?? 0;
  const lo = gap.startNew + topLen;
  const hi = gap.endNew - botLen;
  if (lo > hi) return null; // already closed
  if (edge === "all") return { start: lo, end: hi };
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

// Splice revealed rows back into the server's row list. A gap whose two edges
// have met loses its separator entirely, so a fully-expanded file reads as one
// continuous run with no leftover markers.
export function mergeRevealed(lines: DiffLine[], gaps: Gap[], reveal: RevealMap): MergedLines {
  const byKey = new Map(gaps.map((g) => [g.key, g]));
  const out: DiffLine[] = [];
  const gapFor = new Map<DiffLine, { gap: Gap; hidden: number }>();

  const emitGap = (gap: Gap, separator: DiffLine | null) => {
    const r = reveal[gap.key];
    const hidden = gapSize(gap) - revealed(r);
    if (r) out.push(...r.top);
    if (hidden > 0) {
      // Clone so the separator's identity is unique per render pass and its
      // reported remaining count can't go stale.
      const row: DiffLine = separator
        ? { ...separator }
        : { type: "hunk", oldLine: null, newLine: null, html: "", text: "" };
      gapFor.set(row, { gap, hidden });
      out.push(row);
    }
    if (r) out.push(...r.bottom);
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const gap = ln.type === "hunk" ? byKey.get(i) : undefined;
    if (gap) emitGap(gap, ln);
    else out.push(ln);
  }
  const trailing = byKey.get(TRAILING_GAP);
  if (trailing) emitGap(trailing, null);
  return { lines: out, gapFor };
}
