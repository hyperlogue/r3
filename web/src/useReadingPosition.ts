import { type RefObject, useLayoutEffect, useRef } from "react";
import { captureFileReadingAnchor, resolveFileReadingPosition } from "./file-reading-position.ts";
import { readingPositions } from "./reading-position.ts";
import { restoreReadingPosition } from "./restore-reading-position.ts";

// Restore after asynchronous file/iframe sizing, but relinquish control as soon
// as the reader interacts or an explicit Locate owns scrolling.
export function useReadingPosition(
  root: RefObject<HTMLElement | null>,
  key: string | null,
  explicit: boolean,
  version: number | null,
  files?: { path: string; activate: (path: string) => boolean },
) {
  const previousVersion = useRef<number | null>(null);
  useLayoutEffect(() => {
    const reset = previousVersion.current !== version;
    previousVersion.current = version;
    const pane = root.current;
    if (!pane || !key) return;
    const saved = readingPositions.get(key);
    const point = saved ?? (reset ? { x: 0, y: 0 } : null);
    // Old absolute stack offsets cannot identify a location after lazy layout.
    // Reopen the requested file instead of hydrating the entire prefix to guess.
    const anchor = saved && files ? (saved.file ?? { path: files.path, offset: 0 }) : null;
    let restoring = !!point && !explicit;
    const stop =
      restoring && point
        ? restoreReadingPosition(
            pane,
            point,
            () => {
              restoring = false;
            },
            () =>
              anchor && files
                ? resolveFileReadingPosition(pane, point, anchor, files.activate)
                : point,
          )
        : undefined;
    const save = () => {
      if (!restoring)
        readingPositions.set(
          key,
          { x: pane.scrollLeft, y: pane.scrollTop },
          files ? captureFileReadingAnchor(pane) : undefined,
        );
    };
    pane.addEventListener("scroll", save, { passive: true });
    return () => {
      stop?.();
      pane.removeEventListener("scroll", save);
    };
  }, [root, key, explicit, version, files]);
}
