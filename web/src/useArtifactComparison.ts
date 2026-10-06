import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactDetail } from "../../shared/artifacts.ts";
import { artifactComparisons } from "./artifact-comparison.ts";

export function useArtifactComparison(
  detail: ArtifactDetail,
  initialSearch: string,
  syncLocation: boolean,
) {
  const comparisons = useMemo(() => artifactComparisons(detail), [detail]);
  const [replyId, setReplyId] = useState<string | null>(() =>
    new URLSearchParams(initialSearch).get("compare"),
  );
  const active = replyId !== null;
  const [retainedId, setRetainedId] = useState(replyId);
  const trigger = useRef<HTMLElement | null>(null);
  const scroll = useRef<{ node: HTMLElement; top: number }[]>([]);
  if (replyId && replyId !== retainedId) setRetainedId(replyId);
  const remember = useCallback(() => {
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    scroll.current = [...document.querySelectorAll<HTMLElement>("[data-feedback-queue]")].map(
      (node) => ({ node, top: node.scrollTop }),
    );
  }, []);
  useEffect(() => {
    if (!syncLocation) return;
    const restore = () => {
      const next = new URLSearchParams(location.search).get("compare");
      if (next && !replyId) remember();
      setReplyId(next);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [replyId, remember, syncLocation]);
  useEffect(() => {
    if (active) return;
    const frame = requestAnimationFrame(() => {
      for (const { node, top } of scroll.current) node.scrollTop = top;
      if (trigger.current?.isConnected) trigger.current.focus({ preventScroll: true });
    });
    // Keep both surfaces during the reverse slide, then release its previews.
    const timer = setTimeout(() => setRetainedId(null), 500);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [active]);
  const open = useCallback(
    (id: string) => {
      if (!comparisons.has(id)) return;
      if (!active) remember();
      if (syncLocation) {
        const url = new URL(location.href);
        url.searchParams.set("compare", id);
        if (active) history.replaceState(history.state, "", url);
        else {
          history.pushState(history.state, "", url);
          history.replaceState({ ...history.state, r3Comparison: history.length }, "", url);
        }
      }
      setReplyId(id);
    },
    [active, comparisons, remember, syncLocation],
  );
  const close = useCallback(
    (back = true) => {
      if (!active) return;
      setReplyId(null);
      if (!syncLocation) return;
      if (back && history.state?.r3Comparison === history.length) history.back();
      else {
        const url = new URL(location.href);
        url.searchParams.delete("compare");
        history.replaceState(null, "", url);
      }
    },
    [active, syncLocation],
  );
  return {
    active,
    comparisons,
    selected: comparisons.get(replyId ?? retainedId ?? "") ?? null,
    retained: retainedId !== null,
    open,
    close,
  };
}
