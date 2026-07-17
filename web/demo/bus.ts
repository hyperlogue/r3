// An in-process stand-in for the daemon's SSE stream. The real SPA opens
// `new EventSource("/api/events?…")` in hooks.ts; here we install a global
// EventSource shim so that code runs UNCHANGED — every backend write calls
// broadcast(), which dispatches the same ServerEvent shapes to every live
// subscriber, and TanStack Query invalidates exactly as it does over the wire.

import type { ServerEvent } from "../../shared/types.ts";

type Listener = (ev: { data: string }) => void;

const live = new Set<DemoEventSource>();

// Mirrors just enough of the EventSource surface hooks.ts touches: `onopen`,
// `addEventListener(type, cb)` (cb gets a `{ data }` MessageEvent-lite), and
// `close()`. Named events arrive by type, payload JSON-encoded in `data`.
class DemoEventSource {
  onopen: (() => void) | null = null;
  readyState = 0;
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(public readonly url: string) {
    live.add(this);
    // Fire `open` on a microtask — after the synchronous effect body has finished
    // wiring listeners — matching a real connection's async first open.
    queueMicrotask(() => {
      if (this.readyState !== 2) {
        this.readyState = 1;
        this.onopen?.();
      }
    });
  }

  addEventListener(type: string, cb: Listener): void {
    let s = this.listeners.get(type);
    if (!s) {
      s = new Set();
      this.listeners.set(type, s);
    }
    s.add(cb);
  }

  removeEventListener(type: string, cb: Listener): void {
    this.listeners.get(type)?.delete(cb);
  }

  close(): void {
    this.readyState = 2;
    live.delete(this);
  }

  dispatch(type: string, data: string): void {
    for (const cb of this.listeners.get(type) ?? []) cb({ data });
  }
}

// Push a server event to every open subscriber. Like the daemon's fallback path
// (a file-changed with no reviewIds), we broadcast to all; hooks.ts already
// filters by reviewId inside its handlers, so per-connection scoping isn't needed.
export function broadcast(ev: ServerEvent): void {
  const data = JSON.stringify(ev);
  for (const es of live) es.dispatch(ev.type, data);
}

// Replace the platform EventSource with the shim. Called as an import side effect
// of the demo api module, which main.tsx imports before it ever renders <App/>.
export function installEventSourceShim(): void {
  (globalThis as unknown as { EventSource: unknown }).EventSource = DemoEventSource;
}
