// Imperative feedback-highlight machinery for the review's content pane. The
// pane's rows live inside dangerouslySetInnerHTML server HTML, so React can't
// own these marks — the hooks toggle classes / CSS Custom Highlights directly
// and re-apply them as the DOM changes. Three cooperating hooks: the transient
// active ring + navigation scroll (useActiveLineHighlight), its summary-prose
// sibling (useActiveSummaryHighlight — the two split ownership of the shared
// HL_ACTIVE registry, see the comments at each), and the persistent
// unresolved-feedback region wash (useRegionHighlight) — plus the Region shape
// they share and the click refinement that resolves a markdown block's
// overlapping feedback to the quote under the cursor. Extracted from
// ReviewView.tsx verbatim.

import { useEffect, useRef } from "react";
import {
  HL_ACTIVE,
  HL_FEEDBACK,
  rangeForQuote,
  setHighlightRanges,
  supportsHighlights,
} from "./mdhighlight.ts";
import { SCROLL_RATIO } from "./pane.ts";
import type { DiffSide, FeedbackWithReplies } from "./types.ts";
import { SUMMARY_FILE } from "./types.ts";
import { fileScrollKey, type ScrollToLine } from "./virtual.tsx";

// FileCard's sticky header (h-8 = 32px) overlays the top of the scroll pane, so
// a row in that band sits inside the pane's box but is visually covered — the
// anchor-in-view test treats it as off screen.
const STICKY_HEADER_PX = 32;

// Imperatively ring the lines an active feedback points at (its DOM rows live
// inside dangerouslySetInnerHTML content, so we toggle a class directly) and,
// only on a human navigation, scroll them to ~30% of the pane. Two concerns,
// split: the effect re-runs and re-marks the rows on any anchor-primitive change
// (so a live re-anchor keeps the ring on the right line), but it issues a scroll
// ONLY when `fbId` or `scrollNonce` differs from the previous run — the human
// clicked a feedback, or re-clicked locate. A background anchor shift (server
// re-anchor → new line_start, or a diff-placement move) re-rings in place without
// yanking the pane. Even a navigation skips the scroll when the anchored rows are
// already fully on screen — saving a note on the selection under your eyes (or
// locating a visible line) rings in place instead of re-seating the pane.
export function useActiveLineHighlight(
  scope: React.RefObject<HTMLElement | null>,
  fb: FeedbackWithReplies | null,
  scrollNonce: number,
  scrollToLine: ScrollToLine,
) {
  const fbId = fb?.id ?? null;
  const file = fb?.file ?? null;
  const side = fb?.side ?? null;
  const lineStart = fb?.line_start ?? null;
  const lineEnd = fb?.line_end ?? null;
  const patchSeq = fb?.patch_seq ?? null;
  const quote = fb?.quote ?? null;
  // The fbId/scrollNonce of the previous run, so a run can tell a human navigation
  // (scroll) from an anchor merely shifting under a stable selection (mark only).
  const prevScroll = useRef<{ fbId: string | null; nonce: number }>({ fbId: null, nonce: -1 });
  // scrollNonce is both read (to decide shouldScroll below) and a dep, so an
  // explicit locate click re-runs this and re-scrolls even when the anchor hasn't
  // changed.
  useEffect(() => {
    const root = scope.current;
    if (!root) return;
    for (const el of root.querySelectorAll(".r3-active-line"))
      el.classList.remove("r3-active-line");
    // Summary notes (prose, not file rows) are owned by useActiveSummaryHighlight,
    // which also drives HL_ACTIVE for the located quote — bail before this hook
    // would fight it over the same registry (or spin its retry loop on a
    // non-existent `@summary` file). The bail comes BEFORE the registry clear:
    // this effect can re-run on line-hint-only dep changes the summary hook
    // doesn't share (e.g. a re-anchor moving line_start under the same quote, or
    // a snapshot-view flip nulling the hints), and clearing here would wipe a
    // summary quote's highlight that the summary hook won't re-paint.
    if (file === SUMMARY_FILE) return;
    setHighlightRanges(HL_ACTIVE, []);
    // Scroll only on a human navigation — a new feedback or a re-clicked locate; a
    // background anchor shift (same fbId + nonce) re-marks the rows in place.
    const shouldScroll =
      fbId !== prevScroll.current.fbId || scrollNonce !== prevScroll.current.nonce;
    prevScroll.current = { fbId, nonce: scrollNonce };
    // A whole-file note has a real path but no line span: bring the file's header
    // into view without marking a row. Retry across a few frames so a folded file
    // that locateFeedback just unfolded has time to mount.
    if (fbId != null && file != null && file !== SUMMARY_FILE && lineStart == null) {
      if (!shouldScroll) return;
      const scopeSel = patchSeq != null ? `[data-round="${patchSeq}"] ` : "";
      let tries = 0;
      let raf = requestAnimationFrame(function toFile() {
        const el = root.querySelector(`${scopeSel}[data-file="${CSS.escape(file)}"]`);
        if (el) {
          const p = root.getBoundingClientRect();
          const r = el.getBoundingClientRect();
          // The note covers the whole file — any part of it already on screen
          // means the target is in view; don't yank the pane to its header.
          if (r.bottom > p.top && r.top < p.bottom) return;
          root.scrollTo({ top: root.scrollTop + r.top - p.top - 8, behavior: "smooth" });
          return;
        }
        if (++tries > 60) return;
        raf = requestAnimationFrame(toFile);
      });
      return () => cancelAnimationFrame(raf);
    }
    if (fbId == null || file == null || lineStart == null) return;
    // Rounds can repeat a path with unrelated line numbers, so an anchor that
    // names a round resolves inside that round's scope only; a null patch_seq
    // (files review / legacy) falls back to the first match = the first round.
    const scopeSel = patchSeq != null ? `[data-round="${patchSeq}"] ` : "";
    const scrollKey = fileScrollKey(patchSeq, file);
    // A navigation to an anchor that's already fully on screen (minus the
    // sticky-header band) skips the scroll — the ring alone marks it. Rows
    // resolve only when mounted, so a virtualized-away or folded target reports
    // not-visible and scrolls as before.
    const anchorInView = (): boolean => {
      const fileEl = root.querySelector(`${scopeSel}[data-file="${CSS.escape(file)}"]`);
      if (!fileEl) return false;
      const row = (n: number) => rowEl(fileEl, n, side);
      let head: Element | Range | null = row(lineStart);
      let tail: Element | Range | null =
        lineEnd == null || lineEnd === lineStart ? head : row(lineEnd);
      // Rendered markdown has no per-line rows — measure the quoted text when
      // findable (the enclosing block is far wider than the anchor), else the
      // containing block, mirroring mark()'s resolution below.
      if (!head || !tail) {
        const block = findBlockForRange(fileEl, lineStart, lineEnd ?? lineStart);
        if (!block) return false;
        head = tail = (quote ? rangeForQuote(block, quote) : null) ?? block;
      }
      const p = root.getBoundingClientRect();
      // The covered band at the pane top: the file header, plus the mobile
      // sticky toolbar whose live height rides on the pane as --pane-sticky-h
      // (0 when unset — desktop).
      const toolbarPx =
        Number.parseFloat(getComputedStyle(root).getPropertyValue("--pane-sticky-h")) || 0;
      return (
        head.getBoundingClientRect().top >= p.top + toolbarPx + STICKY_HEADER_PX &&
        tail.getBoundingClientRect().bottom <= p.bottom
      );
    };
    const doScroll = shouldScroll && !anchorInView();
    // If the file is virtualized, scroll the anchor line on screen first — the
    // row is otherwise unmounted and no querySelector below would find it. The
    // virtualizer owns the scroll then (returns true); a short file / rendered
    // markdown returns false and we scroll to the row ourselves. A folded file
    // that locateFeedback just told to open registers a frame or two late, so
    // the retry below keeps re-issuing this until it takes. Only when scrolling.
    let scrolled = doScroll && scrollToLine(scrollKey, lineStart, side, { align: "center" });

    // Mark the anchored rows/block and return the first (or null if not yet
    // mounted). Re-runnable so we can retry until the virtualizer mounts the row.
    const mark = (): boolean => {
      const fileEl = root.querySelector(`${scopeSel}[data-file="${CSS.escape(file)}"]`);
      if (!fileEl) return false;
      let first: Element | null = null;
      for (let n = lineStart; n <= (lineEnd ?? lineStart); n++) {
        const el = rowEl(fileEl, n, side);
        if (el) {
          el.classList.add("r3-active-line");
          first ??= el;
        }
      }
      // Markdown render has no per-line rows — ring the block the anchor falls in,
      // but highlight only the quoted text within it when we can find it (the
      // whole block is far wider than the anchor); the block is still the scroll
      // target either way.
      if (!first) {
        const block = findBlockForRange(fileEl, lineStart, lineEnd ?? lineStart);
        if (block) {
          const range = quote && supportsHighlights() ? rangeForQuote(block, quote) : null;
          if (range) setHighlightRanges(HL_ACTIVE, [range]);
          else block.classList.add("r3-active-line");
          first = block;
        }
      }
      if (!first) return false;
      // Bring the row into view only on a navigation, and only when the
      // virtualizer didn't already own the jump (a plain / folded / markdown file).
      if (doScroll && !scrolled) {
        const offset = first.getBoundingClientRect().top - root.getBoundingClientRect().top;
        root.scrollTo({
          top: root.scrollTop + offset - root.clientHeight * SCROLL_RATIO,
          behavior: "smooth",
        });
      }
      return true;
    };

    if (mark()) return () => setHighlightRanges(HL_ACTIVE, []);
    // Row not mounted yet — retry across a few frames while the target file
    // opens/mounts. When scrolling, re-issue the (live-rect-based, deterministic)
    // scroll each frame: for a virtualized jump, KEEP re-issuing for a settle
    // window past the first hit, since an unfolding file growing content above the
    // scroll position lets the browser's scroll anchoring drift the pane off the
    // target — re-asserting each frame overrides that; a DOM / rendered-markdown
    // scroll (mark self-scrolled, `scrolled` false) needs one hit. When NOT
    // scrolling we only wait to mark a late-mounting row, so stop the moment it's
    // marked. Budget covers the ~200ms unfold; an absent line gives up.
    let tries = 0;
    let foundAt = -1;
    let raf = requestAnimationFrame(function retry() {
      if (doScroll) scrolled = scrollToLine(scrollKey, lineStart, side) || scrolled;
      if (mark() && foundAt < 0) foundAt = tries;
      if (foundAt >= 0 && (!doScroll || !scrolled || tries - foundAt > 15)) return;
      if (++tries > 60) return;
      raf = requestAnimationFrame(retry);
    });
    return () => {
      cancelAnimationFrame(raf);
      setHighlightRanges(HL_ACTIVE, []);
    };
  }, [scope, fbId, file, side, lineStart, lineEnd, patchSeq, quote, scrollNonce, scrollToLine]);
}

// The DOM row for line `n` on `side` within `fileEl`: a diff row carries data-side,
// a files-review row is single-sided (a null `side` matches the first row with
// that line number). The one place the side-scoping rule for a code row lives.
function rowEl(fileEl: Element, n: number, side: DiffSide | null): Element | null {
  return side
    ? fileEl.querySelector(`[data-line="${n}"][data-side="${side}"]`)
    : fileEl.querySelector(`[data-line="${n}"]`);
}

// Rendered markdown has no per-line rows; blocks span data-line-start..end — and
// the anchor line rarely equals a block's *start* line, so find the block that
// *contains* the range (the same overlap test as the region highlight), not one
// starting exactly at the anchor.
function findBlockForRange(fileEl: Element, start: number, end: number): Element | null {
  for (const el of fileEl.querySelectorAll("[data-line-start]")) {
    const bs = Number(el.getAttribute("data-line-start"));
    const be = Number(el.getAttribute("data-line-end") ?? bs);
    if (bs <= end && be >= start) return el;
  }
  return null;
}

// Locate the summary an active summary-feedback points at — the review summary
// (top of the file-viewer column, outside the scroll scope) or a round summary
// (inside it) — and bring it into view. Both summaries render as Markdown, so
// there are no per-line rows: highlight the exact `quote` within the rendered
// prose (best-effort, via the CSS Custom Highlight API) and scroll it on screen;
// fall back to flashing the whole block when the quote can't be found. A round
// summary is immutable so its quote always locates; the review summary is edited
// in place, so a drifted quote lands on the whole-block fallback (accepted).
// Separate from useActiveLineHighlight (which bails on SUMMARY_FILE) so the two
// never fight over the shared HL_ACTIVE registry.
export function useActiveSummaryHighlight(fb: FeedbackWithReplies | null, scrollNonce: number) {
  const isSummary = fb?.file === SUMMARY_FILE;
  const fbId = fb?.id ?? null;
  const patchSeq = fb?.patch_seq ?? null;
  const quote = fb?.quote ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrollNonce is an intentional re-trigger dep
  useEffect(() => {
    for (const el of document.querySelectorAll(".r3-summary-active"))
      el.classList.remove("r3-summary-active");
    // Only clear/drive HL_ACTIVE for an actual summary note. The shared HL_ACTIVE
    // registry also carries a non-summary note's precise-quote highlight, which is
    // owned by useActiveLineHighlight (declared first, so it runs before this hook).
    // Clearing it here unconditionally wiped the focused range's yellow on every
    // rendered-file/diff feedback. The two hooks stay out of each other's slot:
    // the line hook clears only for non-summary notes (it bails on `@summary`
    // before touching the registry), and a stale summary range is cleared by this
    // effect's own cleanup below when the active note changes.
    if (!isSummary || fbId == null) return;
    setHighlightRanges(HL_ACTIVE, []);
    // Document-scoped on purpose: RoundSummary's mobile mount lives in the pane
    // toolbar, outside the scroll pane. data-round-summary pins the seq so a note
    // on a non-displayed round's summary highlights nothing (never the wrong one).
    const block =
      patchSeq == null
        ? document.querySelector('[data-summary="review"]')
        : document.querySelector(`[data-round-summary="${patchSeq}"] [data-summary="round"]`);
    if (!block) return;
    const range = quote && supportsHighlights() ? rangeForQuote(block, quote) : null;
    if (range) {
      setHighlightRanges(HL_ACTIVE, [range]);
      // scrollIntoView on the quote's element pulls it through every scroll
      // ancestor (the summary's own max-h scroll AND the pane), so it lands even
      // when the quote sits below the summary bar's internal fold.
      (range.startContainer.parentElement ?? block).scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    } else {
      block.classList.add("r3-summary-active");
      block.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    return () => setHighlightRanges(HL_ACTIVE, []);
  }, [isSummary, fbId, patchSeq, quote, scrollNonce]);
}

export interface Region {
  id: string;
  file: string;
  start: number;
  end: number;
  // The feedback's quote — its anchor of record. For rendered markdown we use it
  // to highlight the exact text, not the whole enclosing block (see mdhighlight).
  quote: string;
  // In a snapshot-diff view a row carries a side (old/new) and the line numbers
  // are per-side; a region resolved onto one side must only mark that side's rows.
  // Absent for plain file views (all rows are one side).
  side?: DiffSide | null;
}

// The narrowest region covering a line, so clicking a line that several feedbacks
// overlap jumps to the most specific one.
function tightest(regions: Region[]): Region {
  return regions.reduce((a, b) => (b.end - b.start < a.end - a.start ? b : a));
}

// Cross-browser caret hit-test: the (node, offset) directly under a viewport
// point. `caretPositionFromPoint` is the standard; `caretRangeFromPoint` is the
// older WebKit/Blink spelling — try the standard first, then fall back.
function caretNodeOffset(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos) return { node: pos.offsetNode, offset: pos.offset };
  const range = document.caretRangeFromPoint?.(x, y);
  if (range) return { node: range.startContainer, offset: range.startOffset };
  return null;
}

// A rendered-markdown block carries a *single* data-fb-id even when it spans
// several feedbacks' anchors (a whole <ul>/<ol>/<p>), so a click resolved by
// `closest` alone always lands on the first one. Refine it: when the tagged
// element is a markdown block (data-line-start) that more than one feedback
// overlaps, pick the feedback whose quote actually sits under the cursor. Code
// rows (data-line, tagged per-line already) have no data-line-start, so they pass
// straight through as `fallbackId`.
export function refineMarkdownClick(
  holder: Element,
  x: number,
  y: number,
  regions: Region[],
  fallbackId: string | null,
): string | null {
  const bsAttr = holder.getAttribute("data-line-start");
  if (bsAttr == null) return fallbackId;
  const bs = Number(bsAttr);
  const be = Number(holder.getAttribute("data-line-end") ?? bsAttr);
  const file = holder.closest("[data-file]")?.getAttribute("data-file");
  const hits = regions.filter((r) => r.file === file && bs <= r.end && be >= r.start);
  if (hits.length <= 1) return fallbackId;
  const caret = caretNodeOffset(x, y);
  if (!caret) return fallbackId;
  for (const h of hits) {
    const range = rangeForQuote(holder, h.quote);
    if (range?.isPointInRange(caret.node, caret.offset)) return h.id;
  }
  return fallbackId;
}

// Persistently mark the lines/blocks that unresolved feedback points at (a steady
// region highlight, distinct from the transient active-line ring). Imperative,
// like useActiveLineHighlight — the content is server HTML — but re-applied on any
// content mutation (async blob load, fold/unfold, live update) via a
// MutationObserver, so the marks survive re-renders. childList/subtree only, so
// its own class edits (attribute mutations) don't retrigger it.
export function useRegionHighlight(scope: React.RefObject<HTMLElement | null>, regions: Region[]) {
  useEffect(() => {
    const root = scope.current;
    if (!root) return;
    const byFile = new Map<string, Region[]>();
    for (const r of regions) {
      const arr = byFile.get(r.file);
      if (arr) arr.push(r);
      else byFile.set(r.file, [r]);
    }
    const apply = () => {
      for (const el of root.querySelectorAll(".r3-feedback-region"))
        el.classList.remove("r3-feedback-region");
      // data-fb-id tags the row/block a click should jump the panel to; re-derived
      // each pass so it tracks live changes to the feedback set.
      for (const el of root.querySelectorAll("[data-fb-id]")) el.removeAttribute("data-fb-id");
      // Precise text ranges for rendered-markdown feedback (see mdhighlight).
      const ranges: Range[] = [];
      for (const [file, rs] of byFile) {
        const fileEl = root.querySelector(`[data-file="${CSS.escape(file)}"]`);
        if (!fileEl) continue;
        // Code (and raw markdown) rows carry data-line (+ data-side in a diff). Tag
        // each with the tightest feedback covering it so a click jumps the panel to
        // the most specific one; a side-scoped region only marks its own side.
        for (const el of fileEl.querySelectorAll("[data-line]")) {
          const n = Number(el.getAttribute("data-line"));
          const side = el.getAttribute("data-side");
          const cover = rs.filter(
            (r) => n >= r.start && n <= r.end && (r.side == null || r.side === side),
          );
          if (cover.length === 0) continue;
          el.classList.add("r3-feedback-region");
          el.setAttribute("data-fb-id", tightest(cover).id);
        }
        // Rendered-markdown blocks span data-line-start..data-line-end — much
        // wider than the anchored text. Highlight each overlapping feedback's
        // exact quote inside the block; only fall back to washing the whole
        // block for a quote we can't locate (an outdated anchor) or where the
        // browser lacks the Custom Highlight API.
        for (const el of fileEl.querySelectorAll("[data-line-start]")) {
          const bs = Number(el.getAttribute("data-line-start"));
          const be = Number(el.getAttribute("data-line-end") ?? bs);
          const hits = rs.filter((r) => bs <= r.end && be >= r.start);
          if (hits.length === 0) continue;
          const foundIds: string[] = [];
          if (supportsHighlights()) {
            for (const h of hits) {
              const range = rangeForQuote(el, h.quote);
              if (range) {
                ranges.push(range);
                foundIds.push(h.id);
              }
            }
          }
          if (foundIds.length < hits.length) el.classList.add("r3-feedback-region");
          // Click target: prefer a feedback whose quote we actually highlighted.
          el.setAttribute("data-fb-id", foundIds[0] ?? hits[0].id);
        }
      }
      setHighlightRanges(HL_FEEDBACK, ranges);
    };
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        apply();
      });
    };
    apply();
    const obs = new MutationObserver(schedule);
    obs.observe(root, { childList: true, subtree: true });
    return () => {
      obs.disconnect();
      if (raf) cancelAnimationFrame(raf);
      setHighlightRanges(HL_FEEDBACK, []);
    };
  }, [scope, regions]);
}
