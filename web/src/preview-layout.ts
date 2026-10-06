import type { PreviewBootstrap } from "../../shared/preview-protocol.ts";
import type { PreviewConnection } from "./preview-channel.ts";

// Body size is independent of the iframe viewport, so widening a document can
// shrink its frame again. Measuring document.scrollHeight would retain the old
// viewport height and leave a growing blank tail. No retained bytes are changed.
export function installPreviewLayout(
  config: PreviewBootstrap,
  connection: PreviewConnection,
  managed = document.currentScript?.hasAttribute("data-r3-markdown") ||
    config.presentation === "media",
): void {
  if (!managed) return;
  let enabled = false;
  let lastHeight = 0;
  let frame = 0;
  const measure = () => {
    frame = 0;
    if (!enabled || !document.body) return;
    const height = Math.ceil(document.body.getBoundingClientRect().height);
    if (height > 0 && height !== lastHeight) {
      lastHeight = height;
      connection.send({ type: "r3-preview-height", height });
    }
  };
  const schedule = () => {
    if (!enabled) return;
    // Browsers can suspend animation frames in offscreen opaque documents.
    // The first height must arrive before a saved position can scroll here.
    if (lastHeight === 0) measure();
    else if (!frame) frame = requestAnimationFrame(measure);
  };
  const observer = new ResizeObserver(schedule);
  const observe = () => {
    if (document.body) observer.observe(document.body);
    schedule();
  };
  connection.subscribe((message) => {
    if (message?.type !== "r3-preview-display" || message.contextId !== config.contextId) return;
    enabled = message.display?.fitContent === true;
    schedule();
  });
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", observe, { once: true });
  else observe();
  window.addEventListener("pagehide", () => {
    observer.disconnect();
    cancelAnimationFrame(frame);
  });
}
