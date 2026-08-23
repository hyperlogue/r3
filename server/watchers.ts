// In-memory `r3 watch` presence: one slot per review. Same-client reconnects
// take the slot back (a dropped SSE must not be locked out by its own ghost).

import type { WatcherInfo } from "../shared/types.ts";

interface Entry {
  id: number;
  info: WatcherInfo;
  evict: () => void;
}

export type Admission = { ok: true; id: number } | { ok: false; holder: WatcherInfo };

const byReview = new Map<string, Entry>();
let nextId = 1;

// Identity is the pair the client passes on every connect (`--session` /
// `--agent-id`), so a reconnect matches itself. Both must agree: two agents that
// share a display name but carry distinct ids are distinct clients, and an agent
// that grows an id mid-loop is not the process that holds the slot.
const sameClient = (a: WatcherInfo, b: WatcherInfo): boolean =>
  a.session === b.session && (a.agentId ?? "") === (b.agentId ?? "");

export function addWatcher(reviewId: string, info: WatcherInfo, evict: () => void): Admission {
  const held = byReview.get(reviewId);
  if (held && !sameClient(held.info, info)) return { ok: false, holder: held.info };
  const id = nextId++;
  byReview.set(reviewId, { id, info, evict });
  // Tear the ghost down only after the slot is ours: evicting closes its stream,
  // which runs its cleanup synchronously. `removeWatcher` is id-scoped so that
  // cleanup can't delete the entry we just wrote.
  held?.evict();
  return { ok: true, id };
}

// Returns whether this call actually freed the slot: a ghost that closes after
// its successor took over releases nothing, and the caller shouldn't announce a
// change that didn't happen.
export function removeWatcher(reviewId: string, id: number): boolean {
  if (byReview.get(reviewId)?.id !== id) return false;
  byReview.delete(reviewId);
  return true;
}

export function watchersOf(reviewId: string): WatcherInfo[] {
  const held = byReview.get(reviewId);
  return held ? [held.info] : [];
}
