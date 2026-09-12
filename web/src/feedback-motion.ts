import type { AutoAnimationPlugin } from "@formkit/auto-animate";
import { useLayoutEffect, useRef, useState } from "react";
import { prefersReduced } from "./ui.tsx";

// Restore the original feedback panel's motion: rise/fade on entry, exit right,
// and translate between measured positions when the working queue reorders.
export const feedbackAnimation: AutoAnimationPlugin = (element, action, before, after) => {
  const reduce = prefersReduced();
  if (action === "add")
    return new KeyframeEffect(
      element,
      [
        { opacity: 0, transform: "translateY(1.25rem)", offset: 0 },
        { opacity: 1, offset: 0.3 },
        { opacity: 1, transform: "translateY(0)", offset: 1 },
      ],
      { duration: reduce ? 0 : 250, easing: "ease-out" },
    );
  if (action === "remove") {
    // The animation briefly retains removed DOM; its controls are no longer live.
    if (element instanceof HTMLElement) element.inert = true;
    return new KeyframeEffect(
      element,
      [
        { transform: "translate(0, 0)", opacity: 1 },
        { transform: "translate(100%, 0)", opacity: 0 },
      ],
      { duration: reduce ? 0 : 200, easing: "ease-in" },
    );
  }
  const dx = (before?.left ?? 0) - (after?.left ?? 0);
  const dy = (before?.top ?? 0) - (after?.top ?? 0);
  return new KeyframeEffect(
    element,
    [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0, 0)" }],
    { duration: reduce ? 0 : 200, easing: "ease-out" },
  );
};

export function useFeedbackTabIndicator(selected: string) {
  const ref = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  // Selection changes move the indicator; counts/font sizes can resize either
  // tab independently of selection. Observe both without measuring on typing.
  useLayoutEffect(() => {
    const root = ref.current;
    const button = root?.querySelector<HTMLElement>(`[data-feedback-tab="${selected}"]`);
    if (!root || !button) return;
    const measure = () => {
      const next = {
        left: button.offsetLeft,
        top: button.offsetTop,
        width: button.offsetWidth,
        height: button.offsetHeight,
      };
      setBox((previous) =>
        previous &&
        Object.keys(next).every(
          (key) => previous[key as keyof typeof next] === next[key as keyof typeof next],
        )
          ? previous
          : next,
      );
    };
    const resize = new ResizeObserver(measure);
    resize.observe(root);
    for (const tab of root.querySelectorAll("[data-feedback-tab]")) resize.observe(tab);
    measure();
    return () => resize.disconnect();
  }, [selected]);
  return {
    ref,
    style: box
      ? {
          top: box.top,
          width: box.width,
          height: box.height,
          transform: `translateX(${box.left}px)`,
        }
      : undefined,
  };
}
