import type { PreviewBootstrap, PreviewTheme } from "../../shared/preview-protocol.ts";
import type { PreviewConnection } from "./preview-channel.ts";

// Serialized into trusted preview support. The server marks only retained
// Markdown documents; authored HTML keeps its own appearance and theme API.
export function installMarkdownTheme(
  config: PreviewBootstrap,
  connection: PreviewConnection,
): void {
  if (!document.currentScript?.hasAttribute("data-r3-markdown")) return;
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
  document.addEventListener("DOMContentLoaded", apply, { once: true });
}
