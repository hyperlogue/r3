// Map source/diff DOM rows to a native line anchor. Rendered selections are
// handled by the isolated preview runtime and never mapped to source lines.

import { sourceQuoteExcerpt } from "../../shared/source-quote.ts";
import type { DiffSide } from "./types.ts";

export interface PendingAnchor {
  file: string;
  side: DiffSide | null;
  // A whole-file anchor (the file header's threads button) carries a real `file`
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
// note" bubble above `top`, and, with the discussion panel hidden,
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

// Read only code within the native range: gutters, diff signs and blank-row
// placeholders are presentation, not captured source. Join rows explicitly so
// browser layout does not supply (or omit) the quote's line separators.
function selectedLines(range: Range, start: LinePoint, endLine: number) {
  const file = closest(range.startContainer, "data-file");
  if (!file) return null;
  const parts: string[] = [];
  for (const row of file.querySelectorAll<HTMLElement>("[data-line]")) {
    const line = Number(row.dataset.line);
    if (row.dataset.side !== start.side || line < start.line || line > endLine) continue;
    if (line !== start.line + parts.length) return null; // Unmounted or uncaptured gap.
    const code = row.querySelector<HTMLElement>("[data-source-text]");
    if (!code) return null;
    const selected = document.createRange();
    selected.selectNodeContents(code);
    if (range.compareBoundaryPoints(Range.START_TO_START, selected) > 0)
      selected.setStart(range.startContainer, range.startOffset);
    if (range.compareBoundaryPoints(Range.END_TO_END, selected) < 0)
      selected.setEnd(range.endContainer, range.endOffset);
    const text = selected.toString();
    // An endpoint before the last row's code does not select that row. A selected
    // blank placeholder has text, but contributes an empty source line below.
    if (!text && line === endLine && parts.length) {
      endLine -= 1;
      break;
    }
    parts.push(code.hasAttribute("data-empty") ? "" : text);
  }
  if (parts.length !== endLine - start.line + 1) return null;
  const quote = parts.join("\n");
  return quote.trim() ? { quote, end: start.line + parts.length - 1 } : null;
}

export function getSelectionAnchor(scope: HTMLElement): PendingAnchor | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  // The selection has to touch the file view, but it may spill past it — e.g. a
  // drag released over the discussion panel, whose common ancestor with the file
  // view is an outer container. Requiring the *common* ancestor inside `scope`
  // dropped those whole, so re-selecting near the edge silently failed to
  // re-point a pending draft; require just one endpoint inside and clamp to the
  // in-view part below.
  if (!scope.contains(range.startContainer) && !scope.contains(range.endContainer)) return null;

  // Split halves are separate scroll containers; a selection spanning both is
  // DOM-ordered rather than one visual source range. CSS blocks mouse drags
  // across halves; this also covers touch, keyboard selection, and Select All.
  const startHalf = closest(range.startContainer, "data-split-half");
  const endHalf = closest(range.endContainer, "data-split-half");
  if (startHalf && endHalf && startHalf !== endHalf) return null;

  const start = pointFrom(range.startContainer);
  if (!start || start.file == null) return null;
  const end = pointFrom(range.endContainer);

  let endLine = end?.line ?? start.line;
  // Cross-file, cross-side, and out-of-pane selections cannot mix line numbers.
  if (!end || end.file !== start.file || end.side !== start.side) endLine = start.line;
  const selected = selectedLines(range, start, endLine);
  if (!selected) return null;

  const roundEl = closest(range.startContainer, "data-round");
  const patchSeq = roundEl ? Number(roundEl.getAttribute("data-round")) : null;
  return {
    file: start.file,
    side: start.side,
    lineStart: start.line,
    lineEnd: selected.end,
    quote: sourceQuoteExcerpt(selected.quote),
    patchSeq,
  };
}
