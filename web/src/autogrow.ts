// Auto-growing textareas — the feedback composer and reply box start short and
// grow with their content up to a line cap, then scroll.
//
// Two paths to the same box. Where the browser can size a control to its own
// content (`field-sizing: content`) we hand it the job: the rows × line-height
// math becomes a min/max-height pair written ONCE, and a keystroke costs nothing.
// Everywhere else the JS fit below runs per keystroke — it collapses the box to
// `height:auto` so `scrollHeight` reports the true content height (this is what
// lets it shrink again, not just grow), which forces a synchronous layout on
// every character typed. That forced layout is the reason the native path is
// preferred, not merely tolerated.

import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";

// Probed once at module load: it's a constant of the browser, not of a composer.
const FIELD_SIZING =
  typeof CSS !== "undefined" &&
  typeof CSS.supports === "function" &&
  CSS.supports("field-sizing", "content");

// The vertical box math both paths share. Heights are border-box (Tailwind's
// preflight), so padding + border ride along in every number below.
function bounds(el: HTMLTextAreaElement, minRows: number, maxRows: number) {
  const cs = getComputedStyle(el);
  const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
  const vPad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const vBorder = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  return { min: line * minRows + vPad + vBorder, max: line * maxRows + vPad + vBorder, vBorder };
}

// Size `el` to fit its value between `minRows` and `maxRows` lines; past the cap
// it stays at max height and scrolls.
function fit(el: HTMLTextAreaElement, minRows: number, maxRows: number): void {
  const { min, max, vBorder } = bounds(el, minRows, maxRows);
  el.style.height = "auto"; // collapse so scrollHeight is the content height, not the old box
  const needed = el.scrollHeight + vBorder; // scrollHeight includes padding, not border
  el.style.height = `${Math.min(Math.max(needed, min), max)}px`;
  el.style.overflowY = needed > max + 0.5 ? "auto" : "hidden";
}

// Hand the growing to the browser: `field-sizing: content` tracks the value, and
// the same min/max the JS path computes becomes the clamp. `overflow-y:auto` only
// shows a scrollbar once the value passes the cap, so it's set once rather than
// toggled. No inline height — leaving one would pin the box the browser is sizing.
function applyFieldSizing(el: HTMLTextAreaElement, minRows: number, maxRows: number): void {
  const { min, max } = bounds(el, minRows, maxRows);
  el.style.setProperty("field-sizing", "content");
  el.style.minHeight = `${min}px`;
  el.style.maxHeight = `${max}px`;
  el.style.overflowY = "auto";
  el.style.height = "";
}

const size = FIELD_SIZING ? applyFieldSizing : fit;

// Grow a textarea with its value, from `minRows` up to `maxRows` lines, then
// scroll. Returns a callback ref to put on the textarea: it sizes the node the
// moment it mounts (so a lazily-revealed box — a Collapse opening, an editor
// appearing — is correct on the first frame) and re-measures on width changes
// (panel resize, a font-size change moving the rem math) via a ResizeObserver that
// ignores our own height writes. The passed `ref` object is kept in sync for the
// callers that read it (focus, caret placement). Value changes are handled by a
// layout effect below — on the JS path only.
export function useAutoGrow(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  minRows = 2,
  maxRows = 10,
): (node: HTMLTextAreaElement | null) => void {
  const roRef = useRef<ResizeObserver | null>(null);

  const setRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      ref.current = node;
      roRef.current?.disconnect();
      roRef.current = null;
      if (!node) return;
      size(node, minRows, maxRows);
      let lastWidth = node.clientWidth;
      const ro = new ResizeObserver(() => {
        if (node.clientWidth !== lastWidth) {
          lastWidth = node.clientWidth;
          size(node, minRows, maxRows);
        }
      });
      ro.observe(node);
      roRef.current = ro;
    },
    [ref, minRows, maxRows],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: value is the re-fit trigger — fit() reads el.value directly, not this prop
  useLayoutEffect(() => {
    // The native path re-sizes itself as the value changes; measuring here would
    // put the per-keystroke forced layout straight back.
    if (FIELD_SIZING) return;
    if (ref.current) fit(ref.current, minRows, maxRows);
  }, [ref, value, minRows, maxRows]);

  // The row caps are the only thing the native path re-applies — they're props, so
  // this runs when a caller changes them, never while typing.
  useLayoutEffect(() => {
    if (!FIELD_SIZING || !ref.current) return;
    applyFieldSizing(ref.current, minRows, maxRows);
  }, [ref, minRows, maxRows]);

  return setRef;
}
