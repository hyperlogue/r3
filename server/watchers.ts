// In-memory registry of `r3 watch` clients, keyed by review. A watch
// client identifies itself on its SSE connection with a human-readable session
// string (shown in the UI) and an optional agent id (a precise machine handle
// other tools can use to jump to the agent). The UI reads this to show "an agent
// is watching" (and who), and to switch "Copy prompt" to "Submit". State is
// intentionally ephemeral — it's just live connection presence.

import type { WatcherInfo } from "../shared/types.ts";

const byReview = new Map<string, Map<number, WatcherInfo>>();
let nextId = 1;

export function addWatcher(reviewId: string, info: WatcherInfo): number {
  const id = nextId++;
  let m = byReview.get(reviewId);
  if (!m) {
    m = new Map();
    byReview.set(reviewId, m);
  }
  m.set(id, info);
  return id;
}

export function removeWatcher(reviewId: string, id: number): void {
  const m = byReview.get(reviewId);
  if (!m) return;
  m.delete(id);
  if (m.size === 0) byReview.delete(reviewId);
}

export function watchersOf(reviewId: string): WatcherInfo[] {
  return [...(byReview.get(reviewId)?.values() ?? [])];
}
