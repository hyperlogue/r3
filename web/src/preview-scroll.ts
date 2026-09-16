import type { PreviewBootstrap } from "../../shared/preview-protocol.ts";
import type { PreviewConnection } from "./preview-channel.ts";
import type { restoreReadingPosition } from "./restore-reading-position.ts";

// Serialized into trusted support; only root scroll coordinates cross the
// document-bound channel. Publisher state and nested scrollers are not retained.
export function installPreviewScroll(
  config: PreviewBootstrap,
  connection: PreviewConnection,
  restore: typeof restoreReadingPosition,
): void {
  let enabled = false;
  let restoring = false;
  let stop: (() => void) | undefined;
  let frame = 0;
  const route = () => location.search + location.hash || "#";
  connection.subscribe((message) => {
    if (message?.contextId !== config.contextId) return;
    if (message.type === "r3-preview-display") {
      enabled = config.presentation === "document" && !message.display?.fitContent;
      if (!enabled || message.display?.jump) stop?.();
    } else if (
      message.type === "r3-preview-restore-scroll" &&
      enabled &&
      message.route === route()
    ) {
      stop?.();
      restoring = true;
      stop = restore(window, message.point, () => {
        restoring = false;
      });
    }
  });
  window.addEventListener(
    "scroll",
    () => {
      if (!enabled || restoring || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        connection.send({
          type: "r3-preview-scroll",
          route: route(),
          point: { x: scrollX, y: scrollY },
        });
      });
    },
    { passive: true },
  );
  window.addEventListener("hashchange", () => stop?.());
  window.addEventListener("pagehide", () => {
    stop?.();
    cancelAnimationFrame(frame);
  });
}
