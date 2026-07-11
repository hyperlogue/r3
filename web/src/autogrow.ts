// Auto-growing textareas — the feedback composer and reply box start short and
// grow with their content up to a cap, then scroll. The height is measured off a
// hidden mirror div (never by collapsing the textarea to `height:auto`), so the
// real element's `height` only ever steps old→new; that lets a CSS
// `transition-[height]` animate each step smoothly instead of snapping.
//
// Why a mirror instead of the usual `el.style.height = 'auto';
// el.style.height = el.scrollHeight + 'px'`: resetting to `auto` forces the
// element through its content height mid-measure, which the transition engine
// snapshots as the start value — so the animation has nothing to animate and it
// jumps. A separate off-screen div that matches the textarea's typography, box,
// and content width lays out to the exact height the text needs; we read that and
// assign it once, leaving the textarea's own height untouched until the final set.

import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";

// Computed properties that affect how text wraps + how tall each line is. Copied
// onto the mirror so its line count matches the textarea's exactly.
const TYPE_PROPS = [
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "fontVariant",
  "fontStretch",
  "fontFeatureSettings",
  "letterSpacing",
  "wordSpacing",
  "textTransform",
  "textIndent",
  "lineHeight",
  "tabSize",
] as const;

// One shared, lazily-created mirror — only ever measured synchronously inside a
// ref callback / layout effect, so a single node serves every textarea.
let mirror: HTMLDivElement | null = null;
function getMirror(): HTMLDivElement {
  if (mirror) return mirror;
  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  Object.assign(el.style, {
    position: "absolute",
    top: "0",
    left: "0",
    visibility: "hidden",
    pointerEvents: "none",
    zIndex: "-1",
    height: "auto",
    minHeight: "0",
    overflow: "hidden",
    boxSizing: "content-box", // width/height we set are the pure content box
    margin: "0",
    padding: "0",
    border: "0",
    whiteSpace: "pre-wrap",
    overflowWrap: "break-word",
    wordBreak: "break-word",
  });
  document.body.appendChild(el);
  mirror = el;
  return el;
}

// Size `el` to fit its value between `minRows` and `maxRows` lines; past the cap
// it stays at max height and scrolls. Returns without touching the element when
// it isn't laid out (e.g. a not-yet-opened Collapse with zero width).
function fit(el: HTMLTextAreaElement, minRows: number, maxRows: number): void {
  const width = el.clientWidth;
  if (!width) return;
  const cs = getComputedStyle(el);
  const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2;
  const vPad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const vBorder = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  const hPad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);

  const m = getMirror();
  for (const prop of TYPE_PROPS) m.style[prop] = cs[prop];
  m.style.width = `${width - hPad}px`; // clientWidth includes padding, not border
  // A trailing newline needs a following empty line; append a space so browsers
  // that collapse the final break still count it (also covers the empty case).
  m.textContent = el.value.endsWith("\n") ? `${el.value} ` : el.value;

  // border-box height the textarea needs = measured content + its own pad+border.
  const content = m.getBoundingClientRect().height + vPad + vBorder;
  const min = line * minRows + vPad + vBorder;
  const max = line * maxRows + vPad + vBorder;
  el.style.height = `${Math.min(Math.max(content, min), max)}px`;
  el.style.overflowY = content > max + 0.5 ? "auto" : "hidden";
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
