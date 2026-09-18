import type { PreviewBootstrap, PreviewTheme } from "../../shared/preview-protocol.ts";
import type { PreviewConnection } from "./preview-channel.ts";

// Serialized into trusted preview support. The server marks only retained
// Markdown documents; authored HTML keeps its own appearance and theme API.
export function installMarkdownTheme(
  config: PreviewBootstrap,
  connection: PreviewConnection,
  markdown = document.currentScript?.hasAttribute("data-r3-markdown"),
): void {
  if (!markdown) return;
  let theme: PreviewTheme | null = null;
  let applied: PreviewTheme | null = null;
  let darkRules: CSSMediaRule[] | null = null;
  const apply = () => {
    if (!document.body || !theme || applied === theme) return;
    // Renderer revision 1 retained its syntax palette under an OS media query.
    // Override that presentation condition in memory, including on old versions.
    if (!darkRules) {
      darkRules = [];
      for (const sheet of document.styleSheets) {
        try {
          for (const rule of sheet.cssRules) {
            if (
              rule instanceof CSSMediaRule &&
              /^\(prefers-color-scheme:\s*dark\)$/.test(rule.conditionText)
            )
              darkRules.push(rule);
          }
        } catch {
          /* Only retained inline styles belong to this adapter. */
        }
      }
    }
    for (const rule of darkRules) rule.media.mediaText = theme === "dark" ? "all" : "not all";
    document.documentElement.style.colorScheme = theme;
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.body.style.backgroundColor = theme === "dark" ? "#0a0a0a" : "#ffffff";
    document.body.style.color = theme === "dark" ? "#f5f5f5" : "#171717";
    applied = theme;
  };
  connection.subscribe((message) => {
    if (message?.type !== "r3-preview-display" || message.contextId !== config.contextId) return;
    if (message.display?.theme !== "light" && message.display?.theme !== "dark") return;
    theme = message.display.theme;
    apply();
  });
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", apply, { once: true });
  else apply();
}

// Body size is independent of the iframe viewport, so widening a document can
// shrink its frame again. Measuring document.scrollHeight would retain the old
// viewport height and leave a growing blank tail. No retained bytes are changed.
export function installMarkdownLayout(
  config: PreviewBootstrap,
  connection: PreviewConnection,
  markdown = document.currentScript?.hasAttribute("data-r3-markdown"),
): void {
  if (!markdown) return;
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
