// In-memory registry of `r3 watch` clients, keyed by review. A watch
// client identifies itself on its SSE connection with a human-readable session
// string (shown in the UI) and an optional agent id (a precise machine handle
// other tools can use to jump to the agent). The UI reads this to show "an agent
// is watching" (and who), and to switch "Copy prompt" to "Submit". State is
// intentionally ephemeral — it's just live connection presence.
//
// A review admits ONE watch at a time. Two agents blocked on the same review
// don't split the work, they race it: delivery is marked at POST time, so one
// can stamp the awaiting items sent between the other's GET and POST and that
// one wakes up with an empty prompt (r3-9fc). "● <session> watching" can only
// name an owner if there is exactly one, and Submit hands the round to whoever
// happens to answer first. So a second session is refused — but the SAME client
// reconnecting takes its own slot back: a dropped SSE or a restarted agent must
// not be locked out by its own ghost, which nothing else would ever clear.

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
