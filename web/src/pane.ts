// Small shared helpers for the review's scrolling content pane (the scoped
// scroll container ReviewView owns): the scroll-landing ratio, the composer
// focus reach-around, and the version-switch crossfade. Extracted from
// ReviewView.tsx verbatim so the page file stays the page.

import { type RefObject, useEffect, useRef } from "react";

// Where the focused line sits after a scroll: 30% down the viewport, so there's
// reading context above it.
export const SCROLL_RATIO = 0.3;

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
