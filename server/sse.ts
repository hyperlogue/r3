// A tiny in-process pub/sub the HTTP layer turns into SSE streams. Domain writes
// (feedback, replies, status) and the file watcher broadcast here; subscribed
// browser tabs get live `review-updated` / `feedback-updated` / `file-changed`
// pushes.

import type { ServerEvent } from "../shared/types.ts";

type Listener = (ev: ServerEvent) => void;

const listeners = new Set<Listener>();

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function broadcast(ev: ServerEvent): void {
  for (const fn of listeners) {
    try {
      fn(ev);
    } catch {
      // a slow/broken consumer must not break the writer
    }
  }
}
