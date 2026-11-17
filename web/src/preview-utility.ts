import type { ArtifactUtility, PreviewBootstrap } from "../../shared/preview-protocol.ts";
import type { createPreviewAssets } from "./preview-assets.ts";
import type { PreviewConnection } from "./preview-channel.ts";

// Serialized into the isolated origin as an ES module. Keep runtime dependencies
// inside this function; the compiled binary needs no source tree or bundler.
export function createArtifactUtility(
  config: PreviewBootstrap,
  connection: PreviewConnection,
  assets: typeof createPreviewAssets,
  getUserMedia: ArtifactUtility["getUserMedia"] = () =>
    Promise.reject(new Error("Device capture is unavailable")),
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
  const commentModeListeners = new Set<(commentMode: boolean) => void>();
  let commentMode = false;
  connection.subscribe((message) => {
    if (!message || message.contextId !== config.contextId) return;
    if (message.type === "r3-preview-display") {
      const next = message.display?.commenting === true;
      // Reapplied on every update: publisher code may replace the root class list.
      document.documentElement.classList.toggle("r3-comment-mode", next);
      if (next === commentMode) return;
      commentMode = next;
      for (const listener of commentModeListeners) {
        try {
          listener(next);
        } catch {
          /* One consumer must not prevent other subscribers. */
        }
      }
    } else if (message.type === "r3-preview-changed") {
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
  let closed = false;
  const call = <T>(method: string, input?: unknown, timeout = 30_000): Promise<T> =>
    new Promise((resolve, reject) => {
      if (closed) {
        reject(new Error("The artifact document was closed"));
        return;
      }
      if (pending.size >= 32) {
        reject(new Error("Too many pending r3 requests"));
        return;
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error("r3 did not respond; open this page from the artifact workspace"));
      }, timeout);
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      connection.send({ type: "r3-preview-call", id, method, input });
    });
  window.addEventListener("pagehide", () => {
    closed = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error("The artifact document was closed"));
    }
    pending.clear();
  });
  const utility = {
    ...assets((path) => call<Blob>("readAsset", path, 180_000)),
    getUserMedia,
    getContext: () => call("getContext"),
    getThreads: () => call("getThreads"),
    createThread: (input) => call("createThread", input),
    comment: (input) => call("comment", input),
    submit: () => call("submit"),
    subscribe: (listener) => {
      subscribers.add(listener);
      return () => {
        subscribers.delete(listener);
      };
    },
    isCommentMode: () => commentMode,
    onCommentModeChange: (listener) => {
      commentModeListeners.add(listener);
      return () => {
        commentModeListeners.delete(listener);
      };
    },
  } satisfies ArtifactUtility;
  return Object.freeze(utility);
}
