// Auto-growing textareas — the feedback composer and reply box start short and
// grow with their content up to a line cap, then scroll. On each value/width
// change the box is collapsed to `height:auto` so `scrollHeight` reports the true
// content height (this is what lets it shrink again, not just grow), then that
// height is clamped between `minRows` and `maxRows` lines and written back inline.

import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";

// Size `el` to fit its value between `minRows` and `maxRows` lines; past the cap
// it stays at max height and scrolls.
function fit(el: HTMLTextAreaElement, minRows: number, maxRows: number): void {
  const cs = getComputedStyle(el);
  const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
  const vPad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const vBorder = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  const min = line * minRows + vPad + vBorder;
  const max = line * maxRows + vPad + vBorder;

  el.style.height = "auto"; // collapse so scrollHeight is the content height, not the old box
  const needed = el.scrollHeight + vBorder; // scrollHeight includes padding, not border
  el.style.height = `${Math.min(Math.max(needed, min), max)}px`;
  el.style.overflowY = needed > max + 0.5 ? "auto" : "hidden";
}

// Grow a textarea with its value, from `minRows` up to `maxRows` lines, then
// scroll. Returns a callback ref to put on the textarea: it sizes the node the
// moment it mounts (so a lazily-revealed box — a Collapse opening, an editor
// appearing — is correct on the first frame) and re-measures on width changes
// (panel resize) via a ResizeObserver that ignores our own height writes. The
// passed `ref` object is kept in sync for the callers that read it (focus,
// mention wiring). Value changes are handled by a layout effect below.
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
      fit(node, minRows, maxRows);
      let lastWidth = node.clientWidth;
      const ro = new ResizeObserver(() => {
        if (node.clientWidth !== lastWidth) {
          lastWidth = node.clientWidth;
          fit(node, minRows, maxRows);
        }
      });
      ro.observe(node);
      roRef.current = ro;
    },
    [ref, minRows, maxRows],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: value is the re-fit trigger — fit() reads el.value directly, not this prop
  useLayoutEffect(() => {
    if (ref.current) fit(ref.current, minRows, maxRows);
  }, [ref, value, minRows, maxRows]);

  return setRef;
}
