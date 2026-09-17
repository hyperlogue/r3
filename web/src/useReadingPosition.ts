import { type RefObject, useLayoutEffect, useRef } from "react";
import { type ReadingPosition, readingPositions } from "./reading-position.ts";
import { restoreReadingPosition } from "./restore-reading-position.ts";

// Restore after asynchronous file/iframe sizing, but relinquish control as soon
// as the reader interacts or an explicit Locate owns scrolling.
export function useReadingPosition(
  root: RefObject<HTMLElement | null>,
  key: string | null,
  explicit: boolean,
  version: number | null,
  prepare?: (point: ReadingPosition) => boolean,
) {
  const previousVersion = useRef<number | null>(null);
  useLayoutEffect(() => {
    const reset = previousVersion.current !== version;
    previousVersion.current = version;
    const pane = root.current;
    if (!pane || !key) return;
    const point = readingPositions.get(key) ?? (reset ? { x: 0, y: 0 } : null);
    let restoring = !!point && !explicit;
    const stop =
      restoring && point
        ? restoreReadingPosition(
            pane,
            point,
            () => {
              restoring = false;
            },
            () => prepare?.(point) ?? true,
          )
        : undefined;
    const save = () => {
      if (!restoring) readingPositions.set(key, { x: pane.scrollLeft, y: pane.scrollTop });
    };
    pane.addEventListener("scroll", save, { passive: true });
    return () => {
      stop?.();
      pane.removeEventListener("scroll", save);
    };
  }, [root, key, explicit, version, prepare]);
}
