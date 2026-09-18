import type { PreviewBootstrap } from "../../shared/preview-protocol.ts";
import type { PreviewConnection } from "./preview-channel.ts";

// Serialized into the policy-bearing server shell, never publisher content.
// The parent supplies only hash-checked retained Markdown on this exact port.
export function installMarkdownDocument(
  config: PreviewBootstrap,
  connection: PreviewConnection,
  install: () => void,
): void {
  let mounted = false;
  let fragmentPending = !!location.hash;
  let frame = 0;
  const stop = () => {
    fragmentPending = false;
    cancelAnimationFrame(frame);
  };
  for (const event of ["wheel", "touchstart", "pointerdown", "keydown", "pagehide"])
    window.addEventListener(event, stop, { once: true, passive: true });
  connection.subscribe((message) => {
    if (message?.contextId !== config.contextId) return;
    if (mounted && fragmentPending && message.type === "r3-preview-display") {
      // Native parsing finished before the deferred body existed. Restore its
      // heading fragment once layout is ready; explicit Locate/user input wins.
      if (message.display?.jump) {
        stop();
        return;
      }
      let target: HTMLElement | null;
      try {
        target = document.getElementById(decodeURIComponent(location.hash.slice(1)));
      } catch {
        stop();
        return;
      }
      if (!target) {
        stop();
        return;
      }
      const deadline = performance.now() + 2500;
      const scroll = () => {
        if (!fragmentPending) return;
        if (
          message.display?.fitContent &&
          innerHeight + 1 < document.body.getBoundingClientRect().height &&
          performance.now() < deadline
        ) {
          frame = requestAnimationFrame(scroll);
          return;
        }
        stop();
        target.scrollIntoView();
      };
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(scroll);
      return;
    }
    if (mounted || message.type !== "r3-preview-markdown") return;
    if (typeof message.html !== "string") return;
    mounted = true;
    const template = document.createElement("template");
    template.innerHTML = message.html;
    // Template parsing stays inert. Only retained renderer styles and its main
    // element enter the document; the shell/runtime retain ownership of head.
    for (const style of template.content.querySelectorAll("style")) document.head.append(style);
    const main = template.content.querySelector("main");
    if (!main) return;
    document.body.replaceChildren(main);
    install();
  });
  connection.send({ type: "r3-preview-markdown-needed" });
}
