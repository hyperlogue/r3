// Imperative feedback-highlight machinery for the review's content pane.
// Code/diff rows are React-owned (r3-feedback-region is painted on the row);
// rendered markdown is server HTML, so the remaining hooks toggle classes /
// CSS Custom Highlights and re-apply them as the DOM changes. Three cooperating
// hooks: the transient active ring + navigation scroll (useActiveLineHighlight),
// its summary-prose sibling (useActiveSummaryHighlight — the two split ownership
// of the shared HL_ACTIVE registry, see the comments at each), and the persistent
// unresolved-feedback region wash for markdown (useRegionHighlight) — plus the
// Region shape they share and the click refinement that resolves a markdown
// block's click to the feedback whose quote is actually under the cursor.

import { useEffect, useRef } from "react";
import {
  HL_ACTIVE,
  HL_FEEDBACK,
  quotePos,
  rangeForQuote,
  setHighlightRanges,
  supportsHighlights,
} from "./mdhighlight.ts";
import { SCROLL_RATIO, stickyBandPx } from "./pane.ts";
import type { DiffSide, FeedbackWithReplies } from "./types.ts";
import { SUMMARY_FILE } from "./types.ts";
import { fileScrollKey, type ScrollToLine } from "./virtual.tsx";

// Imperatively ring the lines an active feedback points at (its DOM rows live
// inside dangerouslySetInnerHTML content, so we toggle a class directly) and,
// only on an explicit locate, scroll them to ~30% of the pane. Two concerns,
// split: the effect re-runs and re-marks the rows on any anchor-primitive change
// (so a live re-anchor keeps the ring on the right line), but it issues a scroll
// ONLY when `scrollNonce` differs from the previous run — the human clicked a
// card's file:line header, a reply's pin, or pressed `o`. Merely *focusing* a
// different card (resolve/reply advancing down the list, `j`/`k`, clicking a
// highlighted region) re-rings in place without yanking the pane, as does a
// background anchor shift (server re-anchor → new line_start, or a
// diff-placement move). Even a locate skips the scroll when the anchored rows are
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
  // The scrollNonce of the previous run, so a run can tell an explicit locate
  // (scroll) from focus landing on a card or an anchor shifting (mark only).
  // Initialized to the mount-time nonce so the first mere focus doesn't scroll.
  const prevScroll = useRef(scrollNonce);
  // scrollNonce is both read (to decide shouldScroll below) and a dep, so an
  // explicit locate click re-runs this and re-scrolls even when the anchor hasn't
  // changed.
  useEffect(() => {
    // Consume the nonce before any bail (the summary bail below runs for summary
    // notes), so a locate that this run can't act on doesn't linger and fire a
    // scroll on a later focus-only run.
    const shouldScroll = scrollNonce !== prevScroll.current;
    prevScroll.current = scrollNonce;
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
        head = tail =
          (quote
            ? rangeForQuote(block, quote, quotePos(block, lineStart, lineEnd ?? lineStart))
            : null) ?? block;
      }
      const p = root.getBoundingClientRect();
      const bandTop = p.top + stickyBandPx(root);
      const top = head.getBoundingClientRect().top;
      const bottom = tail.getBoundingClientRect().bottom;
      // In view = fits inside the visible band, OR is taller than it and already
      // spans it. A big anchor (a long quote, a whole washed markdown list) can
      // never satisfy the first test, so without the second one it re-seated the
      // pane on every activation — including a click landing *inside* it, which
      // yanked the very text under the cursor to 30%.
      return (top >= bandTop && bottom <= p.bottom) || (top <= bandTop && bottom >= p.bottom);
    };
    const doScroll = shouldScroll && !anchorInView();
    // If the file is virtualized, scroll the anchor line on screen first — the
    // row is otherwise unmounted and no querySelector below would find it. The
    // virtualizer owns the scroll then (returns true); a short file / rendered
    // markdown returns false and we scroll to the row ourselves. A folded file
    // that locateFeedback just told to open registers a frame or two late, so
    // the retry below keeps re-issuing this until it takes. Only when scrolling.
    // One opts object for BOTH issues of this scroll: the retry below re-issues it
    // every frame while an unfolding file settles, so passing align here and
    // dropping it there would let the last frame land the row at the default 30%
    // — i.e. the alignment would only ever hold for an already-mounted row.
    const scrollOpts = { align: "center" } as const;
    let scrolled = doScroll && scrollToLine(scrollKey, lineStart, side, scrollOpts);

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
          const range =
            quote && supportsHighlights()
              ? rangeForQuote(block, quote, quotePos(block, lineStart, lineEnd ?? lineStart))
              : null;
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
      if (doScroll) scrolled = scrollToLine(scrollKey, lineStart, side, scrollOpts) || scrolled;
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

interface MdBlock {
  el: Element;
  bs: number;
  be: number;
}

// Rendered markdown has no per-line rows; blocks span data-line-start..end, and
// they nest (a <li> inside its <ul>, a <tr> inside <tbody>).
function blockList(fileEl: Element): MdBlock[] {
  const out: MdBlock[] = [];
  for (const el of fileEl.querySelectorAll("[data-line-start]")) {
    const bs = Number(el.getAttribute("data-line-start"));
    const be = Number(el.getAttribute("data-line-end") ?? bs);
    out.push({ el, bs, be });
  }
  return out;
}

// The block(s) a line range resolves to — the one place that rule lives, shared
// by the region wash and the active-line ring.
//
// Prefer the NARROWEST block that contains the range *whole*. A block is only a
// search scope: the quote is looked up inside it, so the smallest scope that can
// still hold the whole quote is the one that keeps the precise highlight. Picking
// the narrowest *overlap* instead would hand a note spanning two <li> just the
// first item, where its quote can't be found — losing the precise paint and
// marking half the anchor. Ties go to the deepest (document order puts an
// ancestor first, and only an ancestor can tie with its descendant: sibling
// blocks have disjoint ranges).
//
// Nothing contains a range that runs across two top-level blocks — then fall back
// to every innermost block it overlaps, so the whole span is still marked and no
// ancestor re-widens it.
function blocksForRange(blocks: MdBlock[], start: number, end: number): Element[] {
  let container: Element | null = null;
  let span = Number.POSITIVE_INFINITY;
  for (const b of blocks) {
    if (b.bs > start || b.be < end) continue;
    if (b.be - b.bs <= span) {
      container = b.el;
      span = b.be - b.bs;
    }
  }
  if (container) return [container];
  const overlap = blocks.filter((b) => b.bs <= end && b.be >= start);
  return overlap
    .filter((b) => !overlap.some((o) => o.el !== b.el && b.el.contains(o.el)))
    .map((b) => b.el);
}

// The single block to ring/measure for an anchor — the anchor line rarely equals
// a block's *start* line, so this resolves by containment, not by start line.
function findBlockForRange(fileEl: Element, start: number, end: number): Element | null {
  return blocksForRange(blockList(fileEl), start, end)[0] ?? null;
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
  // Same locate-vs-focus split as useActiveLineHighlight: only a nonce bump (an
  // explicit locate) scrolls; focus landing on a summary note marks in place.
  const prevScroll = useRef(scrollNonce);
  useEffect(() => {
    // Consume the nonce before the non-summary bail, mirroring the line hook.
    const shouldScroll = scrollNonce !== prevScroll.current;
    prevScroll.current = scrollNonce;
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
      if (shouldScroll) {
        (range.startContainer.parentElement ?? block).scrollIntoView({
          behavior: "smooth",
          block: "center",
        });
      }
    } else {
      block.classList.add("r3-summary-active");
      if (shouldScroll) block.scrollIntoView({ behavior: "smooth", block: "center" });
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
  const cover = regions.filter(
    (r) => line >= r.start && line <= r.end && (r.side == null || r.side === side),
  );
  return cover.length === 0 ? undefined : tightest(cover);
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

// A rendered-markdown block carries a *single* data-fb-id for the whole
// <p>/<ul>/<table> even though the anchor is usually one phrase inside it — and
// when the quote is locatable, the paint is that phrase alone (::highlight
// (r3-feedback), not the block wash). Resolving a click by `closest` alone
// therefore made the entire block a hit target: clicking prose nowhere near the
// mark focused a feedback and jumped the pane. Match the click target to what's
// actually painted — the feedback whose quote sits under the cursor wins, and a
// click that misses every located quote is a miss (null), like clicking blank
// file space. The exception is a hit whose quote we couldn't locate: that one IS
// washed block-wide (see useRegionHighlight), so the whole block stays its
// target. Code rows (data-line, tagged per-line already) have no
// data-line-start, so they pass straight through as `fallbackId`.
export function refineMarkdownClick(
  holder: Element,
  x: number,
  y: number,
  regions: Region[],
  fallbackId: string | null,
): string | null {
  const bsAttr = holder.getAttribute("data-line-start");
  if (bsAttr == null) return fallbackId;
  // No Custom Highlight API → useRegionHighlight washes whole blocks and paints
  // no quote ranges at all, so the block is the mark and stays the hit target.
  if (!supportsHighlights()) return fallbackId;
  const bs = Number(bsAttr);
  const be = Number(holder.getAttribute("data-line-end") ?? bsAttr);
  const fileEl = holder.closest("[data-file]");
  const file = fileEl?.getAttribute("data-file");
  const hits = regions.filter((r) => r.file === file && bs <= r.end && be >= r.start);
  if (hits.length === 0 || !fileEl) return fallbackId;
  const caret = caretNodeOffset(x, y);
  if (!caret) return fallbackId;
  const blocks = blockList(fileEl);
  const unlocated: string[] = [];
  for (const h of hits) {
    // Locate the quote in the block(s) the region RESOLVES to (blocksForRange),
    // not the clicked holder: a note spanning two <li> resolves to — and is
    // painted in — the <ul>, while the click lands in a nested <li> where the
    // quote can't fully match. Searching only the holder counted such a note
    // "unlocated", making blank space in either bullet jump to it. This mirrors
    // useRegionHighlight, so "unlocated" means the same thing in both: only a
    // note that is actually washed block-wide keeps its block as the target —
    // and only when the click landed inside that washed block.
    let range: Range | null = null;
    const els = blocksForRange(blocks, h.start, h.end);
    for (const el of els) {
      range = rangeForQuote(el, h.quote, quotePos(el, h.start, h.end));
      if (range) break;
    }
    if (range) {
      if (range.isPointInRange(caret.node, caret.offset)) return h.id;
    } else if (els.some((el) => el === holder || el.contains(holder))) {
      unlocated.push(h.id);
    }
  }
  return unlocated[0] ?? null;
}

// Persistently mark the rendered-markdown blocks that unresolved feedback points
// at (a steady region highlight, distinct from the transient active-line ring).
// Code/diff rows paint the same class in React; this hook must not strip those.
// Re-applied on content mutation (async blob load, fold/unfold) via a
// MutationObserver. childList/subtree only, so its own class edits (attribute
// mutations) don't retrigger it.
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
      // Markdown-only: never touch [data-line] rows (DiffView/FileView own those).
      for (const el of root.querySelectorAll("[data-line-start].r3-feedback-region"))
        el.classList.remove("r3-feedback-region");
      // data-fb-id tags the block a click should jump the panel to; re-derived
      // each pass so it tracks live changes to the feedback set.
      for (const el of root.querySelectorAll("[data-line-start][data-fb-id]"))
        el.removeAttribute("data-fb-id");
      // Precise text ranges for rendered-markdown feedback (see mdhighlight).
      const ranges: Range[] = [];
      for (const [file, rs] of byFile) {
        const fileEl = root.querySelector(`[data-file="${CSS.escape(file)}"]`);
        if (!fileEl) continue;
        // Rendered-markdown blocks span data-line-start..data-line-end — still
        // wider than the anchored text. Resolve each region to its block
        // (blocksForRange: the narrowest one containing it), then highlight that
        // feedback's exact quote inside; only fall back to washing the whole
        // block for a quote we can't locate (an outdated anchor) or where the
        // browser lacks the Custom Highlight API. Per-region, not per-block:
        // blocks nest, so a per-block overlap test would mark a note on one
        // bullet on its <li> AND its whole <ul> — washing (and making clickable)
        // the entire list.
        const blocks = blockList(fileEl);
        if (blocks.length === 0) continue;
        const marks = new Map<Element, Region[]>();
        for (const r of rs) {
          for (const el of blocksForRange(blocks, r.start, r.end)) {
            const at = marks.get(el);
            if (at) at.push(r);
            else marks.set(el, [r]);
          }
        }
        for (const [el, hits] of marks) {
          const foundIds: string[] = [];
          if (supportsHighlights()) {
            for (const h of hits) {
              const range = rangeForQuote(el, h.quote, quotePos(el, h.start, h.end));
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
