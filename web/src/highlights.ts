// Shared source/diff region lookup. Rendered targets stay inside the preview.
import type { DiffSide } from "./types.ts";

export interface Region {
  id: string;
  file: string;
  start: number;
  end: number;
  // The native source/diff quote associated with this publication region.
  quote: string;
  // In a diff view a row carries a side (old/new) and the line numbers
  // are per-side; a region resolved onto one side must only mark that side's rows.
  // Absent for plain file views (all rows are one side).
  side?: DiffSide | null;
}

// The narrowest region covering a line, so clicking a line that several feedbacks
// overlap jumps to the most specific one.
export function tightest(regions: Region[]): Region {
  return regions.reduce((a, b) => (b.end - b.start < a.end - a.start ? b : a));
}

// Tightest region covering `line` on `side`. `regions` should already be this
// file's (a span from another path can share a line number).
export function regionAt(
  regions: Region[],
  line: number,
  side?: DiffSide | null,
): Region | undefined {
  // Called per rendered row, so the common shape — a review with no open
  // feedback — must not allocate a filtered array per row to find nothing.
  if (regions.length === 0) return undefined;
  const cover = regions.filter(
    (r) => line >= r.start && line <= r.end && (r.side == null || r.side === side),
  );
  return cover.length === 0 ? undefined : tightest(cover);
}
