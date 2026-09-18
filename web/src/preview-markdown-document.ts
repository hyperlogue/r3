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
  connection.subscribe((message) => {
    if (
      mounted ||
      message?.contextId !== config.contextId ||
      message.type !== "r3-preview-markdown"
    )
      return;
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
