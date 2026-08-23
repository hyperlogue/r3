// In-process pub/sub the HTTP layer turns into SSE streams.

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
