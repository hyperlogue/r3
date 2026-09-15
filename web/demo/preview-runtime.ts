import type { PreviewBootstrap } from "../../shared/preview-protocol.ts";
import type { PreviewConnection } from "../src/preview-channel.ts";

// Serialized into a srcdoc document. Its port has only preview UI events; it
// exposes no API credentials, storage, device grants, or publication operations.
export function connectDemoPreview(
  config: PreviewBootstrap & { route: string },
): PreviewConnection {
  const channel = new MessageChannel();
  const port = channel.port1;
  const listeners = new Set<(message: any) => void>();
  let route = config.route;
  const send = (message: Record<string, unknown>) => {
    if (message.locator && typeof message.locator === "object")
      message = { ...message, locator: { ...message.locator, route } };
    port.postMessage({ ...message, contextId: config.contextId, path: config.entryPath });
  };
  const scrollRoute = () => {
    try {
      document.getElementById(decodeURIComponent(route.slice(1)))?.scrollIntoView();
    } catch {
      /* Invalid fragments are inert. */
    }
  };
  port.onmessage = (event) => {
    let message = event.data;
    if (message?.contextId !== config.contextId) return;
    if (message.type === "r3-preview-display") {
      const display = message.display;
      if (display?.theme === "light" || display?.theme === "dark") {
        document.documentElement.classList.toggle("dark", display.theme === "dark");
        document.documentElement.style.colorScheme = display.theme;
      }
      if (display?.jump?.locator) {
        const targetRoute = display.jump.locator.route;
        if (typeof targetRoute === "string" && targetRoute.startsWith("#")) route = targetRoute;
        // srcdoc has no published URL. The adapter keeps native fragment
        // evidence while preventing the shared runtime from navigating about:srcdoc.
        message = {
          ...message,
          display: {
            ...display,
            jump: {
              ...display.jump,
              locator: { ...display.jump.locator, route: location.search + location.hash || "#" },
            },
          },
        };
      }
    }
    for (const listener of listeners) listener(message);
  };
  parent.postMessage(
    { type: "r3-demo-preview-connect", contextId: config.contextId, path: config.entryPath },
    config.applicationOrigin,
    [channel.port2],
  );
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || !(event.target instanceof Element)) return;
    const link = event.target.closest<HTMLAnchorElement>("a[data-demo-path]");
    if (!link) return;
    event.preventDefault();
    const nextRoute = link.dataset.demoRoute || "#";
    if (link.dataset.demoPath === config.entryPath) {
      route = nextRoute;
      scrollRoute();
    } else
      send({
        type: "r3-demo-preview-navigation",
        nextPath: link.dataset.demoPath,
        route: nextRoute,
      });
  });
  document.addEventListener("DOMContentLoaded", scrollRoute, { once: true });
  window.addEventListener("pagehide", () => port.close(), { once: true });
  return {
    send,
    subscribe: (listener) => {
      listeners.add(listener);
    },
  };
}
