import { type RefObject, useEffect } from "react";
import { fileScrollKey, type ScrollToLine } from "./virtual.tsx";

export interface ArtifactCodeJump {
  path: string;
  start?: number;
  end?: number;
  side: "old" | "new";
  nonce: number;
}

// Observe hydration as well as the first paint: a retained context request can
// finish after the first scroll attempt. Each effect cleanup invalidates every
// queued frame so an older Locate cannot steal a newer jump.
export function useArtifactCodeJump({
  scopeRef,
  jump,
  seq,
  ready,
  scrollToLine,
  activate,
}: {
  scopeRef: RefObject<HTMLElement | null>;
  jump: ArtifactCodeJump | null;
  seq: number | null;
  ready: boolean;
  scrollToLine: ScrollToLine;
  activate: (path: string) => boolean;
}) {
  useEffect(() => {
    const root = scopeRef.current;
    if (!root || !ready || !jump) return;
    let live = true;
    let frame = 0;
    let settled = false;
    let settleFrames = 0;
    const selector = `[data-file="${CSS.escape(jump.path)}"]`;
    const clear = () => {
      for (const row of root.querySelectorAll(".r3-active-line"))
        row.classList.remove("r3-active-line");
    };
    const paint = () => {
      frame = 0;
      if (!live) return;
      const file = root.querySelector<HTMLElement>(selector);
      clear();
      if (!file) return;
      if (jump.start !== undefined) {
        for (const row of file.querySelectorAll<HTMLElement>(
          `[data-line][data-side="${jump.side}"], [data-${jump.side}-line]`,
        )) {
          const line = Number(row.getAttribute(`data-${jump.side}-line`) ?? row.dataset.line);
          if (line >= jump.start && line <= (jump.end ?? jump.start))
            row.classList.add("r3-active-line");
        }
      }
      if (settled) return;
      if (jump.start !== undefined) {
        const virtual = scrollToLine(fileScrollKey(seq, jump.path), jump.start, jump.side);
        const row = file.querySelector<HTMLElement>(
          `[data-line="${jump.start}"][data-side="${jump.side}"], [data-${jump.side}-line="${jump.start}"]`,
        );
        if (!virtual && !row) return;
        if (!virtual && row)
          root.scrollTo({
            top:
              root.scrollTop +
              row.getBoundingClientRect().top -
              root.getBoundingClientRect().top -
              root.clientHeight * 0.3,
          });
      } else
        root.scrollTo({
          top: root.scrollTop + file.getBoundingClientRect().top - root.getBoundingClientRect().top,
        });
      if (++settleFrames >= 4) settled = true;
      else frame = requestAnimationFrame(paint);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true });
    activate(jump.path);
    schedule();
    return () => {
      live = false;
      cancelAnimationFrame(frame);
      observer.disconnect();
      clear();
    };
  }, [scopeRef, jump, seq, ready, scrollToLine, activate]);
}
