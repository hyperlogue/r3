// Small shared helpers for the review's scrolling content pane (the scoped
// scroll container ReviewView owns): the scroll-landing ratio, the retrying
// row jump behind the pin/ref locates, the composer focus reach-around, and
// the version-switch crossfade. Extracted from ReviewView.tsx so the page
// file stays the page.

import { type RefObject, useEffect, useRef } from "react";
import { getFontSize } from "./settings.ts";
import type { DiffSide } from "./types.ts";
import type { ScrollToLine } from "./virtual.tsx";

// Where the focused line sits after a scroll: 30% down the viewport, so there's
// reading context above it.
export const SCROLL_RATIO = 0.3;

// FileCard's sticky header overlays the top of the scroll pane, so a row in that
// band sits inside the pane's box but is visually covered. Its `h-8` is 2rem, and
// rem here is the ROOT font size — which is a user setting (settings.ts, 11–24px,
// default 18), not the 16px a literal 32 would assume. Read it from the same store
// that writes --r3-font-size rather than hard-coding one rem's worth of pixels: at
// the default the header is 36px, and at FONT_MAX it is 48.
const HEADER_REM = 2;

// The covered band at the pane's top edge: each file's sticky header, plus the
// mobile pane toolbar whose live height rides on the pane as --pane-sticky-h (0
// when unset — desktop, or no toolbar). Anything landing above this line is
// hidden under the chrome, so both the "is the anchor on screen?" test
// (highlights.ts) and a scroll asking to land at the pane top (virtual.tsx's
// align:"start") have to clear it. NOT the scroll-spy: it measures how much of a
// file the pane shows, and while a file is current the band holds that file's own
// header — which is a label, not lost reading height.
export function stickyBandPx(pane: HTMLElement): number {
  const toolbar =
    Number.parseFloat(getComputedStyle(pane).getPropertyValue("--pane-sticky-h")) || 0;
  return toolbar + getFontSize() * HEADER_REM;
}

// The retrying scroll-a-row-into-view loop behind ReviewView's pin/ref jumps
// (locatePin, jumpToRef). Try the virtualizer first — a virtualized file's
// target row may be unmounted, so only its virtualizer can bring it on screen —
// and KEEP re-issuing for a settle window past the first hit, since an
// unfolding file growing content above the scroll position lets the browser's
// scroll anchoring drift the pane off the target. A short / non-virtualized /
// rendered-markdown file returns false → fall back to the DOM row, waiting a
// bounded number of frames for a folded/opening file to mount it before
// settling for the container top, and land it at SCROLL_RATIO. The budget
// covers the ~200ms unfold; an absent target gives up.
export function retryScrollToRow(opts: {
  getRoot: () => HTMLElement | null;
  scrollToLine: ScrollToLine;
  // The virtualizer registry key; null skips the virtualizer branch (no
  // file/line to address — e.g. a file-less round pin).
  scrollKey: string | null;
  // Selector for the block to land on when the row itself can't be found: the
  // (round-scoped) file, or the round itself for a file-less pin.
  containerSel: string;
  line: number | null;
  // Preferred row side, passed to the virtualizer and the DOM query (pins
  // prefer "new" — they point at the fix, not the old code); a side-less query
  // falls back to the first matching row.
  side: DiffSide | null;
}): void {
  const { getRoot, scrollToLine, scrollKey, containerSel, line, side } = opts;
  let tries = 0;
  let scrolledAt = -1;
  const step = () => {
    const root = getRoot();
    if (!root) return;
    if (scrollKey != null && line != null && scrollToLine(scrollKey, line, side)) {
      if (scrolledAt < 0) scrolledAt = tries;
      if (tries - scrolledAt > 15) return;
      tries++;
      requestAnimationFrame(step);
      return;
    }
    const container = root.querySelector(containerSel);
    if (container) {
      const row =
        line != null
          ? ((side
              ? container.querySelector(`[data-line="${line}"][data-side="${side}"]`)
              : null) ?? container.querySelector(`[data-line="${line}"]`))
          : null;
      // Line named but its row hasn't mounted yet (file still opening) — wait
      // a few frames before settling for the container top.
      if (!row && line != null && ++tries <= 45) {
        requestAnimationFrame(step);
        return;
      }
      const target = row ?? container;
      const offset = target.getBoundingClientRect().top - root.getBoundingClientRect().top;
      root.scrollTo({
        top: root.scrollTop + offset - root.clientHeight * SCROLL_RATIO,
        behavior: "smooth",
      });
      return;
    }
    if (++tries <= 45) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// Focus the feedback panel's anchored composer (it lives outside the calling
// subtree, so it's reached by a data attr rather than a ref) and land the caret
// at the end. One rAF is enough: the draft-store write flushes its subscribers
// synchronously inside the click event, so the textarea is committed before the
// frame fires.
export function focusComposer() {
  requestAnimationFrame(() => {
    const ta = document.querySelector<HTMLTextAreaElement>("textarea[data-anchored-composer]");
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });
}

// Crossfade the content pane when the rendered version changes — a diff-round
// switch or a snapshot from/to change should read as a deliberate move, not a hard
// cut. Played imperatively (WAAPI) on the *existing* pane element so the
// virtualized file cards never remount: a remount would reset scroll position and
// each card's local fold state (worse than no animation). `key` encodes only the
// rendered version, so unrelated re-renders (SSE feedback, scroll-spy, theme
// refetch) don't fire it; a null key means "nothing rendered yet" and is skipped
// on both sides so an initial load or a loading gap never animates. Reduced-motion
// swaps instantly. No cleanup: the animation has fill:none and reverts to the
// pane's resting opacity of 1.
export function usePaneCrossfade(ref: RefObject<HTMLElement | null>, key: string | null) {
  const prev = useRef<string | null>(null);
  useEffect(() => {
    const from = prev.current;
    prev.current = key;
    if (from == null || key == null || from === key) return;
    const el = ref.current;
    if (!el) return;
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches)
      return;
    for (const a of el.getAnimations()) a.cancel();
    el.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
  }, [ref, key]);
}
