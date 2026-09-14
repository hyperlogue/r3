import {
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

type Rect = { x: number; y: number; width: number; height: number };
export type PanelEdge = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";
const storageKey = "r3-feedback-floating-rect";
function readRect(): Rect | null {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey) ?? "null");
    return value &&
      [value.x, value.y, value.width, value.height].every(Number.isFinite) &&
      value.width > 0 &&
      value.height > 0
      ? value
      : null;
  } catch {
    return null;
  }
}
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

// Floating geometry is independent of the dock's width. Keep every control inside
// the workspace, even after restoring a saved rectangle on a smaller screen.
export function useFloatingPanel(
  containerRef: RefObject<HTMLElement | null>,
  enabled: boolean,
  defaultWidth: number | undefined,
) {
  const [rect, setRect] = useState<Rect | null>(readRect);
  const current = useRef(rect);
  const cleanup = useRef<(() => void) | null>(null);
  const bounds = () => {
    const container = containerRef.current;
    if (!container?.clientWidth || !container.clientHeight) return null;
    const inset = Math.min(
      container.clientHeight,
      (Number.parseFloat(getComputedStyle(container).getPropertyValue("--pane-sticky-h")) || 0) + 8,
    );
    const left = Math.min(8, container.clientWidth / 2);
    const right = Math.max(left, container.clientWidth - 8);
    const bottom = Math.max(inset, container.clientHeight - 8);
    return {
      left,
      top: inset,
      right,
      bottom,
      minWidth: Math.min(300, right - left),
      maxWidth: Math.min(700, right - left),
      minHeight: Math.min(240, bottom - inset),
    };
  };
  const fit = (value: Rect): Rect => {
    const box = bounds();
    if (!box) return value;
    const width = clamp(value.width, box.minWidth, box.maxWidth);
    const height = clamp(value.height, box.minHeight, box.bottom - box.top);
    return {
      width,
      height,
      x: clamp(value.x, box.left, box.right - width),
      y: clamp(value.y, box.top, box.bottom - height),
    };
  };
  const apply = (value: Rect, save = false) => {
    const next = fit(value);
    const old = current.current;
    current.current = next;
    if (!old || Object.keys(next).some((key) => next[key as keyof Rect] !== old[key as keyof Rect]))
      setRect(next);
    if (save) localStorage.setItem(storageKey, JSON.stringify(next));
  };
  const initialize = () => {
    if (!enabled) return;
    const box = bounds();
    if (!box) return;
    const width = defaultWidth ?? (containerRef.current?.clientWidth ?? 1100) * 0.382;
    apply(
      current.current ?? {
        x: box.right - width,
        y: box.top,
        width,
        height: box.bottom - box.top,
      },
    );
  };
  // A parent can mount after the hook, or update the sticky toolbar's inset.
  const measure = useEffectEvent(initialize);
  useLayoutEffect(() => measure());
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !enabled) return;
    const resize = new ResizeObserver(() => measure());
    const style = new MutationObserver(() => measure());
    resize.observe(container);
    style.observe(container, { attributes: true, attributeFilter: ["style"] });
    return () => {
      resize.disconnect();
      style.disconnect();
    };
  }, [containerRef, enabled]);
  useEffect(() => {
    if (!enabled) cleanup.current?.();
  }, [enabled]);
  useEffect(() => () => cleanup.current?.(), []);

  const changed = (start: Rect, dx: number, dy: number, edge?: PanelEdge): Rect => {
    if (!edge) return { ...start, x: start.x + dx, y: start.y + dy };
    const box = bounds();
    if (!box) return start;
    let { x, y, width, height } = start;
    if (edge.includes("e"))
      width = clamp(start.width + dx, box.minWidth, Math.min(box.maxWidth, box.right - x));
    if (edge.includes("s")) height = clamp(start.height + dy, box.minHeight, box.bottom - y);
    if (edge.includes("w")) {
      x = clamp(
        start.x + dx,
        Math.max(box.left, start.x + start.width - box.maxWidth),
        start.x + start.width - box.minWidth,
      );
      width = start.x + start.width - x;
    }
    if (edge.includes("n")) {
      y = clamp(start.y + dy, box.top, start.y + start.height - box.minHeight);
      height = start.y + start.height - y;
    }
    return { x, y, width, height };
  };
  const start = (event: ReactPointerEvent<HTMLElement>, edge?: PanelEdge) => {
    if (!enabled || event.button !== 0 || !event.isPrimary || !current.current) return;
    cleanup.current?.();
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const pointer = event.pointerId;
    const origin = current.current;
    const { clientX, clientY } = event;
    const { cursor, userSelect } = document.body.style;
    try {
      handle.setPointerCapture(pointer);
    } catch {
      /* The pointer may already be cancelled. */
    }
    document.body.style.cursor = edge ? `${edge}-resize` : "grabbing";
    document.body.style.userSelect = "none";
    const move = (next: PointerEvent) => {
      if (next.pointerId === pointer)
        apply(changed(origin, next.clientX - clientX, next.clientY - clientY, edge));
    };
    const end = (next: PointerEvent) => {
      if (next.pointerId !== pointer) return;
      cleanup.current?.();
      if (current.current) apply(current.current, true);
    };
    cleanup.current = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      handle.removeEventListener("lostpointercapture", end);
      if (handle.hasPointerCapture(pointer)) handle.releasePointerCapture(pointer);
      document.body.style.cursor = cursor;
      document.body.style.userSelect = userSelect;
      cleanup.current = null;
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    handle.addEventListener("lostpointercapture", end);
  };
  const key = (event: KeyboardEvent, edge?: PanelEdge) => {
    if (
      !enabled ||
      !current.current ||
      !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 50 : 10;
    apply(
      changed(
        current.current,
        event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0,
        event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0,
        edge,
      ),
      true,
    );
  };
  return {
    rect,
    start,
    key,
    resetWidth: () => {
      if (current.current)
        apply(
          { ...current.current, width: (containerRef.current?.clientWidth ?? 1100) * 0.382 },
          true,
        );
    },
  };
}
