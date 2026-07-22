// Map a DOM text selection to a feedback anchor: { file, side, lineStart,
// lineEnd, quote }. Code/diff lines carry data-line (+ data-side); Markdown
// blocks carry data-line-start/end; the file path lives on the nearest
// [data-file] ancestor (the quote is the anchor of record).

import type { DiffSide } from "./types.ts";
// MAX_QUOTE_LINES (the cap on a stored quote's leading lines, applied in
// getSelectionAnchor / getSummaryAnchor below) lives in shared/ because the
// server's line-anchored derived quotes (server/reviews.ts deriveQuote) apply the
// same cap — so the two sides agree on how long an anchor quote can get.
import { MAX_QUOTE_LINES, SUMMARY_FILE } from "./types.ts";

export interface PendingAnchor {
  file: string;
  side: DiffSide | null;
  // A whole-file anchor (the file header's feedback button) carries a real `file`
  // but no span: lineStart/lineEnd/quote are null. A selection or gutter pick fills
  // all three; a summary anchor fills the sentinel file + a derived range.
  lineStart: number | null;
  lineEnd: number | null;
  quote: string | null;
  // Which stored diff round the selection was made in (diff reviews; the rows
  // live under a [data-round] wrapper). Absent/null for files reviews.
  patchSeq?: number | null;
}

// Trim trailing whitespace and cap the quote at MAX_QUOTE_LINES leading lines: a
// short span relocates far more reliably than a paragraphs-long one. Kept verbatim
// (no ellipsis) so it still matches the source — the recorded line range still
// covers the full selection. Shared by both anchor builders.
function capQuote(raw: string): string {
  const quote = raw.replace(/\s+$/, "");
  const lines = quote.split("\n");
  return lines.length > MAX_QUOTE_LINES ? lines.slice(0, MAX_QUOTE_LINES).join("\n") : quote;
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

// `which` picks the line attribute: a code/diff row carries data-line; a
// Markdown block carries data-line-start (its first line) and data-line-end.
function pointFrom(node: Node | null, which: "start" | "end"): LinePoint | null {
  const lineEl = closest(node, "data-line");
  if (lineEl) {
    const side = (closest(node, "data-side")?.getAttribute("data-side") || null) as DiffSide | null;
    return {
      file: closest(node, "data-file")?.getAttribute("data-file") ?? null,
      side,
      line: Number(lineEl.getAttribute("data-line")),
    };
  }
  const attr = which === "start" ? "data-line-start" : "data-line-end";
  const blockEl = closest(node, attr);
  if (blockEl) {
    return {
      file: closest(node, "data-file")?.getAttribute("data-file") ?? null,
      side: null,
      line: Number(blockEl.getAttribute(attr)),
    };
  }
  return null;
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

  const start = pointFrom(range.startContainer, "start");
  if (!start || start.file == null) return null;
  const end = pointFrom(range.endContainer, "end");

  let endLine = end?.line ?? start.line;
  // A selection that ends at the very start of a row (caret at offset 0) does
  // not actually cover that row — back up one.
  if (end && range.endOffset === 0 && endLine > start.line) endLine -= 1;
  // The anchor's file+side come from the start; if the selection crosses into a
  // different file or diff side — or spills out of the file view, so `end` never
  // resolves — don't mix line numbers: clamp to the start.
  if (!end || end.file !== start.file || end.side !== start.side) endLine = start.line;

  const lo = Math.min(start.line, endLine);
  const hi = Math.max(start.line, endLine);

  let quote = sel.toString();
  // A single-line anchor: the DOM selection may have run past that line into the
  // panel or the next file (a drag released outside the file view), so keep only
  // the line's own text — the quote is the re-anchor key. A genuine
  // one-line selection has no newline, so this is a no-op for it.
  if (lo === hi) quote = quote.split("\n", 1)[0];
  if (!quote.trim()) return null;
  quote = capQuote(quote);

  const roundEl = closest(range.startContainer, "data-round");
  const patchSeq = roundEl ? Number(roundEl.getAttribute("data-round")) : null;
  return { file: start.file, side: start.side, lineStart: lo, lineEnd: hi, quote, patchSeq };
}

// The character offset of (node, offset) within `scope`'s text, so a DOM Range in
// a prose block maps back to an offset into its plain text.
function offsetWithin(scope: HTMLElement, node: Node, offset: number): number {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  let total = 0;
  let n = walker.nextNode();
  while (n) {
    if (n === node) return total + offset;
    total += (n.textContent ?? "").length;
    n = walker.nextNode();
  }
  return total;
}

// Map a text selection inside a *summary* (a review's or a diff round's, both
// plain prose — not code/diff rows) to a feedback anchor. Unlike
// getSelectionAnchor there are no per-line data attributes: the quote is the
// anchor of record and the line range is derived by counting newlines in the
// summary text. `patchSeq` names the round for a round summary, null for the
// review summary. Returns null unless the whole selection lands inside `scope`.
export function getSummaryAnchor(
  scope: HTMLElement,
  patchSeq: number | null,
): PendingAnchor | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!scope.contains(range.startContainer) || !scope.contains(range.endContainer)) return null;

  const raw = sel.toString();
  if (!raw.trim()) return null;

  const full = scope.textContent ?? "";
  const startOff = offsetWithin(scope, range.startContainer, range.startOffset);
  const endOff = offsetWithin(scope, range.endContainer, range.endOffset);
  const lineOf = (off: number) => (full.slice(0, off).match(/\n/g)?.length ?? 0) + 1;
  const lo = lineOf(Math.min(startOff, endOff));
  let hi = lineOf(Math.max(startOff, endOff));
  // A selection ending exactly at a line break doesn't cover the next line.
  if (hi > lo && full[Math.max(startOff, endOff) - 1] === "\n") hi -= 1;

  return {
    file: SUMMARY_FILE,
    side: null,
    lineStart: lo,
    lineEnd: Math.max(lo, hi),
    quote: capQuote(raw),
    patchSeq,
  };
}
