import type { ArtifactUtility, PreviewBootstrap } from "../../shared/preview-protocol.ts";
import type { PreviewConnection } from "./preview-channel.ts";

// Serialized into the isolated origin as an ES module. Keep runtime dependencies
// inside this function; the compiled binary needs no source tree or bundler.
export function createArtifactUtility(
  config: PreviewBootstrap,
  connection: PreviewConnection,
): ArtifactUtility {
  const pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const subscribers = new Set<() => void>();
  connection.subscribe((message) => {
    if (!message || message.contextId !== config.contextId) return;
    if (message.type === "r3-preview-changed") {
      for (const listener of subscribers) {
        try {
          listener();
        } catch {
          /* One consumer must not prevent other subscribers. */
        }
      }
    } else if (message.type === "r3-preview-result" && typeof message.id === "string") {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (typeof message.error === "string") request.reject(new Error(message.error));
      else request.resolve(message.value);
    }
  });
  const call = <T>(method: string, input?: unknown): Promise<T> =>
    new Promise((resolve, reject) => {
      if (pending.size >= 32) {
        reject(new Error("Too many pending r3 requests"));
        return;
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("r3 did not respond; open this page from the artifact workspace"));
      }, 30_000);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      connection.send({ type: "r3-preview-call", id, method, input });
    });
  window.addEventListener("pagehide", () => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("The artifact document was closed"));
    }
    pending.clear();
  });
  return Object.freeze({
    getContext: () => call("getContext"),
    getThreads: () => call("getThreads"),
    createFeedback: (input) => call("createFeedback", input),
    reply: (input) => call("reply", input),
    submit: () => call("submit"),
    subscribe: (listener) => {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
  } satisfies ArtifactUtility);
}
