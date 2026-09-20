import { type AutoAnimationPlugin, getTransitionSizes } from "@formkit/auto-animate";
import { createContext, useLayoutEffect, useRef } from "react";
import type { ArtifactFeedback } from "../../shared/artifacts.ts";
import { prefersReduced } from "./ui.tsx";

// Keep the confirmed card and the departing composer in one React commit, even
// before the query observer delivers its next snapshot. Release after refetch.
export const FeedbackCreationContext = createContext<
  ((feedback: ArtifactFeedback) => () => void) | null
>(null);

const feedbackMorphs = new Map<
  string,
  {
    list: HTMLElement;
    top: number;
    left: number;
    width: number;
    height: number;
    expiry: ReturnType<typeof setTimeout>;
  }
>();

// Capture once, after the server confirms the new note. Only an inline new-note
// composer shares a list slot with the card; floating composers and replies keep
// their existing behavior. An early event-stream read may already contain the ID.
export function prepareFeedbackMorph(form: HTMLFormElement | null, feedbackId: string): void {
  const draft = form?.closest<HTMLElement>("[data-feedback-draft]");
  const list = draft?.parentElement;
  if (!draft || !list || !draft.offsetHeight || prefersReduced()) return;
  draft.dataset.feedbackPosted = feedbackId;
  feedbackMorphs.set(feedbackId, {
    list,
    top: draft.offsetTop,
    left: draft.offsetLeft,
    width: draft.offsetWidth,
    height: draft.offsetHeight,
    // A closed/navigated panel must not retain a detached DOM tree.
    expiry: setTimeout(() => feedbackMorphs.delete(feedbackId), 1000),
  });
}

// Restore the original feedback panel's motion: rise/fade on entry, exit right,
// and translate between measured positions when the working queue reorders.
export const feedbackAnimation: AutoAnimationPlugin = (element, action, before, after) => {
  const reduce = prefersReduced() || !!element.closest("[data-feedback-queue][inert]");
  const id = element instanceof HTMLElement ? element.dataset.artifactFeedback : undefined;
  const morph = id && feedbackMorphs.get(id);
  const destination = action === "add" ? before : after;
  if (morph && destination && action !== "remove" && element.parentElement === morph.list) {
    feedbackMorphs.delete(id!);
    clearTimeout(morph.expiry);
    const [, , heightFrom, heightTo] = getTransitionSizes(
      element,
      { ...destination, width: morph.width, height: morph.height },
      destination,
    );
    const node = element as HTMLElement;
    return new KeyframeEffect(
      element,
      [
        {
          opacity: 0,
          height: `${heightFrom}px`,
          transform: `translate(${morph.left - node.offsetLeft}px, ${morph.top - node.offsetTop}px)`,
          overflow: "hidden",
        },
        { opacity: 1, height: `${heightTo}px`, transform: "translate(0, 0)", overflow: "hidden" },
      ],
      { duration: reduce ? 0 : 280, easing: "ease-out" },
    );
  }
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
    if (element instanceof HTMLElement && element.dataset.feedbackPosted)
      return new KeyframeEffect(element, [{ opacity: 1 }, { opacity: 0 }], {
        duration: reduce ? 0 : 180,
        easing: "ease-out",
      });
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
  const indicatorRef = useRef<HTMLSpanElement>(null);
  const animation = useRef<Animation | null>(null);
  const box = useRef<{
    selected: string;
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  useLayoutEffect(() => () => animation.current?.cancel(), []);
  // Selection changes move the indicator; counts/font sizes can resize either
  // tab independently of selection. Observe both without measuring on typing.
  useLayoutEffect(() => {
    const root = ref.current;
    const indicator = indicatorRef.current;
    const button = root?.querySelector<HTMLElement>(`[data-feedback-tab="${selected}"]`);
    if (!root || !indicator || !button) return;
    const measure = () => {
      const next = {
        selected,
        left: button.offsetLeft,
        top: button.offsetTop,
        width: button.offsetWidth,
        height: button.offsetHeight,
      };
      const previous = box.current;
      if (
        previous &&
        Object.keys(next).every(
          (key) => previous[key as keyof typeof next] === next[key as keyof typeof next],
        )
      )
        return;
      const moving =
        previous &&
        previous.selected !== selected &&
        previous.width > 0 &&
        next.width > 0 &&
        !prefersReduced();
      // Read the running pose before canceling, so a reversal never jumps back
      // to a tab or snaps the background to its unsquashed size.
      const style = moving ? getComputedStyle(indicator) : null;
      const from = style && {
        transform: new DOMMatrixReadOnly(style.transform),
        width: parseFloat(style.width),
        height: parseFloat(style.height),
        top: parseFloat(style.top),
      };
      animation.current?.cancel();
      box.current = next;
      Object.assign(indicator.style, {
        top: `${next.top}px`,
        width: `${next.width}px`,
        height: `${next.height}px`,
        transform: `translateX(${next.left}px) scale(1, 1)`,
      });
      if (!from) return;
      const mix = (start: number, end: number, progress: number) =>
        start + (end - start) * progress;
      const motion = indicator.animate(
        [
          [0, 0],
          [0.16, 0.08],
          [0.5, 1],
          [0.84, 0.08],
          [1, 0],
        ].map(([offset, squash]) => {
          const left = mix(from.transform.m41, next.left, offset);
          const scaleX = mix(offset <= 0.5 ? from.transform.a : 1, 1.18, squash);
          const scaleY = mix(offset <= 0.5 ? from.transform.d : 1, 0.85, squash);
          return {
            offset,
            top: `${mix(from.top, next.top, offset)}px`,
            width: `${mix(from.width, next.width, offset)}px`,
            height: `${mix(from.height, next.height, offset)}px`,
            transform: `translateX(${left}px) scale(${scaleX}, ${scaleY})`,
          };
        }),
        { duration: 380, easing: "cubic-bezier(0.42, 0, 0.58, 1)" },
      );
      animation.current = motion;
    };
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const stop = () => {
      if (reduced.matches) animation.current?.cancel();
    };
    reduced.addEventListener("change", stop);
    const resize = new ResizeObserver(measure);
    resize.observe(root);
    for (const tab of root.querySelectorAll("[data-feedback-tab]")) resize.observe(tab);
    measure();
    return () => {
      resize.disconnect();
      reduced.removeEventListener("change", stop);
    };
  }, [selected]);
  return { ref, indicatorRef };
}
