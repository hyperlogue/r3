import type { PreviewBootstrap } from "../../shared/preview-protocol.ts";

export interface PreviewConnection {
  send(message: Record<string, unknown>): void;
  subscribe(listener: (message: any) => void): void;
}

// Serialized before publisher scripts. The child transfers a port to the exact
// application origin; replies use that document's port, never a WindowProxy
// whose document may have changed while an application request was pending.
export function connectPreview(config: PreviewBootstrap): PreviewConnection {
  const channel = new MessageChannel();
  const path =
    config.presentation === "media"
      ? config.entryPath
      : decodeURIComponent(location.pathname.slice(new URL(config.resourceRoot).pathname.length));
  const listeners = new Set<(message: any) => void>();
  channel.port1.onmessage = (event) => {
    for (const listener of listeners) listener(event.data);
  };
  parent.postMessage(
    { type: "r3-preview-connect", contextId: config.contextId, path },
    config.applicationOrigin,
    [channel.port2],
  );
  window.addEventListener("pagehide", () => channel.port1.close());
  return {
    send: (message) => channel.port1.postMessage({ ...message, contextId: config.contextId, path }),
    subscribe: (listener) => {
      listeners.add(listener);
    },
  };
}
