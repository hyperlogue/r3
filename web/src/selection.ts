// Map a DOM text selection to a feedback anchor: { file, side, lineStart,
// lineEnd, quote }. Code/diff lines carry data-line (+ data-side); Markdown
// blocks carry data-line-start/end; the file path lives on the nearest
// [data-file] ancestor (the quote is the anchor of record).

import type { DiffSide } from "./types.ts";
// capQuote (the cap on a stored quote's leading lines, applied in
// getSelectionAnchor / getSummaryAnchor below) lives in shared/ because every
// other quote producer applies it too — the gutter pick (gutter.ts) and the
// server's line-anchored derived quotes (server/reviews.ts deriveQuote) — so all
// three agree on how long an anchor quote can get.
import { capQuote, SUMMARY_FILE } from "./types.ts";

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

function closest(node: Node | null, attr: string): HTMLElement | null {
  let el = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
  while (el && !el.hasAttribute(attr)) el = el.parentElement;
  return el;
}

interface LinePoint {
  file: string | null;
  side: DiffSide | null;
  line: number;
  // Set when the point resolved through a rendered-markdown block rather than a
  // per-line row: the narrowed block element and its data-line-start. Block
  // geometry needs different endpoint corrections than rows — a block's `line`
  // for an end point is its LAST line, so row arithmetic ("back up one") lands
  // inside content the selection never touched (see getSelectionAnchor).
  block?: { el: HTMLElement; start: number };
}

// Markdown blocks nest (a <li> in its <ul>, a <tr> in <tbody>), and the text
// nodes *between* them (markdown-it's newlines) belong to the container — so an
// endpoint that lands in one of those gaps resolves to the whole list/table.
// Narrow it to the innermost tagged block the selection actually touches:
// the first one for the start, the last for the end. Loops instead of taking one
// step so a nested list descends all the way in.
function narrowToTouched(el: HTMLElement, range: Range, which: "start" | "end"): HTMLElement {
  for (let cur = el; ; ) {
    const inner = [...cur.querySelectorAll<HTMLElement>("[data-line-start]")].filter((k) =>
      range.intersectsNode(k),
    );
    if (inner.length === 0) return cur;
    cur = which === "start" ? inner[0] : inner[inner.length - 1];
  }
}

// `which` picks the line attribute: a code/diff row carries data-line; a
// Markdown block carries data-line-start (its first line) and data-line-end.
function pointFrom(node: Node | null, range: Range, which: "start" | "end"): LinePoint | null {
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
    const el = narrowToTouched(blockEl, range, which);
    return {
      file: closest(node, "data-file")?.getAttribute("data-file") ?? null,
      side: null,
      line: Number(el.getAttribute(attr)),
      block: { el, start: Number(el.getAttribute("data-line-start")) },
    };
  }
  return null;
}

// Does the selection cover any actual text of `el`? A range ending at the very
// start of a block still *intersects* it (the boundary point sits inside the
// element), so intersection can't answer this — measure the covered prefix
// instead. Setting a clone's start past its own end just collapses it ("").
function coversText(range: Range, el: HTMLElement): boolean {
  const r = range.cloneRange();
  r.setStart(el, 0);
  return r.toString().trim() !== "";
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

  const start = pointFrom(range.startContainer, range, "start");
  if (!start || start.file == null) return null;
  const end = pointFrom(range.endContainer, range, "end");

  let endLine = end?.line ?? start.line;
  // A selection that ends at the very start of a row (caret at offset 0) does
  // not actually cover that row — back up one. Rows only: a block end's `line`
  // is the block's LAST line, so "-1" would land inside a block the selection
  // never touched.
  if (end && !end.block && range.endOffset === 0 && endLine > start.line) endLine -= 1;
  // The block twin of that correction: an end block the selection doesn't
  // actually reach into (a triple-click parks the caret at the next block's
  // offset 0) contributes nothing — back up to just before the block.
  if (end?.block && endLine > start.line && !coversText(range, end.block.el))
    endLine = Math.max(start.line, end.block.start - 1);

  let quote = sel.toString();
  // The anchor's file+side come from the start; if the selection crosses into a
  // different file or diff side — or spills out of the file view, so `end` never
  // resolves — don't mix line numbers: clamp to the start.
  if (!end || end.file !== start.file || end.side !== start.side) {
    if (start.block) {
      // Block geometry: the in-file part of the selection is the start block's
      // tail. Anchor the whole block — the honest hint; the server relocates by
      // quote — and cut the quote at the block's edge, so panel or next-file
      // text never leaks into the anchor of record. The row rule below
      // (truncate to the first line) would instead throw away every rendered
      // line after the first soft break.
      endLine = Number(start.block.el.getAttribute("data-line-end")) || start.line;
      const r = range.cloneRange();
      r.setEnd(start.block.el, start.block.el.childNodes.length);
      quote = r.toString();
    } else {
      endLine = start.line;
    }
  }

  const lo = Math.min(start.line, endLine);
  const hi = Math.max(start.line, endLine);

  // A single-line ROW anchor: the DOM selection may have run past that line
  // into the panel or the next file (a drag released outside the file view), so
  // keep only the line's own text — the quote is the re-anchor key. A genuine
  // one-line selection has no newline, so this is a no-op for it. Never for a
  // block anchor: one source line legitimately renders many lines of text (a
  // table row's cells), and the spill case was already clamped at the block's
  // edge above.
  if (lo === hi && !start.block) quote = quote.split("\n", 1)[0];
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
