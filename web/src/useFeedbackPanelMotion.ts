import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { FeedbackPanelMode } from "./settings.ts";
import { prefersReduced } from "./ui.tsx";

type Box = { x: number; y: number; width: number; height: number };
type Snapshot = { mode: FeedbackPanelMode; box: Box; radius: string; shadow: string };
const snapshot = (node: HTMLElement, mode: FeedbackPanelMode): Snapshot => {
  const style = getComputedStyle(node);
  return {
    mode,
    box: node.getBoundingClientRect(),
    radius: style.borderRadius,
    shadow: style.boxShadow,
  };
};

// The layout changes once. Animate the same shell from its previous visual box,
// preserving its children and avoiding per-frame reflow of the content pane.
export function useFeedbackPanelMotion(
  mode: FeedbackPanelMode,
  rect: Box | null,
  dockWidth: number | undefined,
) {
  const ref = useRef<HTMLElement | null>(null);
  const previous = useRef<(Snapshot & { rect: Box | null; dockWidth?: number }) | null>(null);
  const captured = useRef<Snapshot | null>(null);
  const animation = useRef<Animation | null>(null);
  const clipped = useRef<{ host: HTMLElement; overflow: string } | null>(null);
  const clipWorkspace = useCallback(() => {
    const host = ref.current?.parentElement;
    if (!host || clipped.current) return;
    clipped.current = { host, overflow: host.style.overflow };
    // Transformed overflow must not add scrollbars and shift the destination.
    host.style.overflow = "clip";
  }, []);
  const cancel = useCallback(() => {
    const current = animation.current;
    animation.current = null;
    current?.cancel();
    ref.current?.style.removeProperty("transition-property");
    if (clipped.current) {
      clipped.current.host.style.overflow = clipped.current.overflow;
      clipped.current = null;
    }
  }, []);
  const capture = () => {
    if (!ref.current) return;
    captured.current = snapshot(ref.current, mode);
    cancel();
    // Suppress the existing width transition before the mode's layout commit.
    ref.current.style.transitionProperty = "none";
    clipWorkspace();
  };
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || dockWidth === undefined || (mode === "floating" && !rect)) return;
    const old = previous.current;
    if (animation.current && old?.mode === mode && old.rect === rect && old.dockWidth === dockWidth)
      return;
    let from = captured.current ?? old;
    // External mode changes can arrive mid-animation without a control click.
    // Reconstruct the old visual box from the running transform before changing
    // layout coordinates; measuring the new layout with that transform is wrong.
    if (!captured.current && old && animation.current) {
      const style = getComputedStyle(node);
      const matrix = new DOMMatrix(style.transform);
      from = {
        ...old,
        box: {
          x: old.box.x + matrix.e,
          y: old.box.y + matrix.f,
          width: old.box.width * matrix.a,
          height: old.box.height * matrix.d,
        },
        radius: style.borderRadius,
        shadow: style.boxShadow,
      };
    }
    captured.current = null;
    cancel();
    const switching = from && from.mode !== mode && from.mode !== "hidden" && mode !== "hidden";
    if (switching) {
      node.style.transitionProperty = "none";
      clipWorkspace();
    }
    const to = snapshot(node, mode);
    previous.current = { ...to, rect, dockWidth };
    if (!from || !switching || prefersReduced() || !to.box.width || !to.box.height) {
      cancel();
      return;
    }
    const next = node.animate(
      [
        {
          transform: `translate(${from.box.x - to.box.x}px, ${from.box.y - to.box.y}px) scale(${from.box.width / to.box.width}, ${from.box.height / to.box.height})`,
          transformOrigin: "top left",
          borderRadius: from.radius,
          boxShadow: from.shadow,
          overflow: "clip",
        },
        {
          transform: "none",
          transformOrigin: "top left",
          borderRadius: to.radius,
          boxShadow: to.shadow,
          overflow: "clip",
        },
      ],
      { duration: 360, easing: "ease-out" },
    );
    animation.current = next;
    next.onfinish = next.oncancel = () => {
      if (animation.current !== next) return;
      cancel();
    };
  });
  useEffect(() => {
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const change = () => {
      if (reduced.matches) cancel();
    };
    reduced.addEventListener("change", change);
    window.addEventListener("resize", cancel);
    return () => {
      reduced.removeEventListener("change", change);
      window.removeEventListener("resize", cancel);
      cancel();
    };
  }, [cancel]);
  return { ref, capture, cancel };
}
