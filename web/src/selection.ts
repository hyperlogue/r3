// Map source/diff DOM rows to a native line anchor. Rendered selections are
// handled by the isolated preview runtime and never mapped to source lines.

import type { DiffSide } from "./types.ts";
import { capQuote } from "./types.ts";

export interface PendingAnchor {
  file: string;
  side: DiffSide | null;
  // A whole-file anchor (the file header's feedback button) carries a real `file`
  // but no span: lineStart/lineEnd/quote are null. A selection or gutter pick fills
  // all three.
  lineStart: number | null;
  lineEnd: number | null;
  quote: string | null;
  // Which stored diff round the selection was made in (diff reviews; the rows
  // live under a [data-round] wrapper). Absent/null for files reviews.
  patchSeq?: number | null;
}

// Where an anchor gesture happened, in viewport coordinates: `left` is the
// horizontal centre of the selection (or picked row) and `top`/`bottom` its
// vertical extent. It positions the transient UI a gesture raises — the "Quote in
// note" bubble above `top`, and, with the feedback panel hidden,
// the floating composer below `bottom`. Never stored: the quote is the anchor of
// record, this is pixels.
export interface AnchorRect {
  left: number;
  top: number;
  bottom: number;
}

function closest(node: Node | null, attr: string): HTMLElement | null {
  let el = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
  while (el && !el.hasAttribute(attr)) el = el.parentElement;
  return el;
}

interface LinePoint {
  file: string | null;
  side: DiffSide | null;
  line: number;
}

function pointFrom(node: Node | null): LinePoint | null {
  const lineEl = closest(node, "data-line");
  if (!lineEl) return null;
  return {
    file: closest(node, "data-file")?.getAttribute("data-file") ?? null,
    side: (closest(node, "data-side")?.getAttribute("data-side") || null) as DiffSide | null,
    line: Number(lineEl.getAttribute("data-line")),
  };
}

export function getSelectionAnchor(scope: HTMLElement): PendingAnchor | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  // The selection has to touch the file view, but it may spill past it — e.g. a
  // drag released over the feedback panel, whose common ancestor with the file
  // view is an outer container. Requiring the *common* ancestor inside `scope`
  // dropped those whole, so re-selecting near the edge silently failed to
  // re-point a pending draft; require just one endpoint inside and clamp to the
  // in-view part below.
  if (!scope.contains(range.startContainer) && !scope.contains(range.endContainer)) return null;

  // Side-by-side layout: refuse a range whose endpoints sit in different halves.
  // The two halves are separate scroll containers, so such a selection's text is
  // DOM-ordered (the whole left column, then the whole right) — nothing like what
  // was highlighted — and that text is what the "Quote in note" bubble would
  // insert verbatim. The clamp below protects the *anchor* (file/side come from
  // the start, so endLine collapses to it), but not the quote text, so this is a
  // hard refusal rather than a clamp. CSS blocks the mouse path outright
  // (main.css, data-selecting); this covers touch long-press, shift+arrow and
  // Ctrl+A. Scoped to split — in unified there are no halves and the attribute
  // is absent, so a selection running from a del run into an add run (picking a
  // whole hunk, very common) keeps working exactly as before.
  const startHalf = closest(range.startContainer, "data-split-half");
  const endHalf = closest(range.endContainer, "data-split-half");
  if (startHalf && endHalf && startHalf !== endHalf) return null;

  const start = pointFrom(range.startContainer);
  if (!start || start.file == null) return null;
  const end = pointFrom(range.endContainer);

  let endLine = end?.line ?? start.line;
  // Ending at a row's offset zero does not select that row.
  if (end && range.endOffset === 0 && endLine > start.line) endLine -= 1;

  let quote = sel.toString();
  // Cross-file, cross-side, and out-of-pane selections cannot mix line numbers.
  if (!end || end.file !== start.file || end.side !== start.side) endLine = start.line;

  const lo = Math.min(start.line, endLine);
  const hi = Math.max(start.line, endLine);

  // A drag can end in another file or over the panel. Retain only the starting
  // row's quote when its anchor was clamped above.
  if (lo === hi) quote = quote.split("\n", 1)[0];
  if (!quote.trim()) return null;
  quote = capQuote(quote);

  const roundEl = closest(range.startContainer, "data-round");
  const patchSeq = roundEl ? Number(roundEl.getAttribute("data-round")) : null;
  return { file: start.file, side: start.side, lineStart: lo, lineEnd: hi, quote, patchSeq };
}
