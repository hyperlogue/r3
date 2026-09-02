// In-memory presence for a review's ONE waiting agent. Two kinds share the slot:
// `watch` (a process blocked on an SSE stream) and `listen` (a registered harness
// inbox the daemon pushes to). Same-client reconnects take the slot back — a
// dropped SSE, or a restarted agent, must not be locked out by its own ghost.
//
// The registry is in-memory because a listener holds the session's messaging
// token, which must never reach the store. A daemon restart therefore drops every
// listener; that is the same semantics `r3 restart` already carries for in-flight
// watches, and Submit's liveness probe is what surfaces it.

import type { WatcherInfo } from "../shared/types.ts";

// Where to push a `listen` holder's nudge. Memory-only: see the note above.
export interface ListenerTarget {
  socket: string;
  token?: string;
}

// Is this listener's session still there? Injected so the registry stays a pure
// rule and the tests need no real socket.
export type Probe = (target: ListenerTarget) => Promise<boolean>;

interface Entry {
  id: number;
  info: WatcherInfo;
  evict: () => void;
  target?: ListenerTarget; // set iff info.kind === "listen"
}

export type Admission = { ok: true; id: number } | { ok: false; holder: WatcherInfo };

const byReview = new Map<string, Entry>();
let nextId = 1;

// Identity is the pair the client passes on every connect (`--session` /
// `--agent-id`), so a reconnect matches itself. Both must agree: two agents that
// share a display name but carry distinct ids are distinct clients, and an agent
// that grows an id mid-loop is not the process that holds the slot.
//
// `kind` is deliberately NOT part of identity: one agent may hold a review with
// `watch` and then switch to `listen` (or back) mid-loop, and that is the same
// client reclaiming its own slot, not a second one racing for it.
const sameClient = (a: WatcherInfo, b: WatcherInfo): boolean =>
  a.session === b.session && (a.agentId ?? "") === (b.agentId ?? "");

export async function addWatcher(
  reviewId: string,
  info: WatcherInfo,
  evict: () => void,
  opts: { target?: ListenerTarget; probe?: Probe } = {},
): Promise<Admission> {
  // Re-decide after every probe rather than deciding once up front: awaiting a
  // probe yields, so the slot can move under us, and admitting against a holder
  // we read before the await would drop the new one without ever evicting it.
  for (;;) {
    const held = byReview.get(reviewId);
    if (!held || sameClient(held.info, info)) {
      const id = nextId++;
      byReview.set(reviewId, { id, info, evict, target: opts.target });
      // Tear the ghost down only after the slot is ours: evicting closes its
      // stream, which runs its cleanup synchronously. `removeWatcher` is
      // id-scoped so that cleanup can't delete the entry we just wrote.
      held?.evict();
      return { ok: true, id };
    }
    // Held by a different client. A `watch` holder is live by construction — its
    // SSE connection IS the slot, so a dead one has already released. A `listen`
    // holder is only a record, and a dead session's stale record would otherwise
    // lock every other agent out until someone hit Submit. So probe that case,
    // and only that case.
    if (held.target === undefined || opts.probe === undefined)
      return { ok: false, holder: held.info };
    if (await opts.probe(held.target)) return { ok: false, holder: held.info };
    // Stale listener: drop it, then decide again against whatever holds the slot
    // now — which may be a client that arrived while we were probing.
    if (byReview.get(reviewId) === held) {
      byReview.delete(reviewId);
      held.evict();
    }
  }
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

// Where to push this review's nudge, with the registration id it belongs to, or
// null when nobody is listening (an empty slot, or one held by a blocked `r3
// watch`, which is woken over SSE instead). The id travels with the target
// because a push takes seconds: the caller has to be able to drop the exact
// registration it failed to reach, not whatever holds the slot by then.
export function listenerFor(reviewId: string): { id: number; target: ListenerTarget } | null {
  const held = byReview.get(reviewId);
  return held?.target ? { id: held.id, target: held.target } : null;
}

// Drop a listener whose session has gone (a failed probe) or whose review reached
// a terminal status. `id` scopes it the way `removeWatcher` does — a push that
// started before the same client re-registered must not evict the registration
// that replaced it; omit it to drop whoever is listening now (a closed review has
// no next round for anyone). Returns whether a listener was actually dropped, so
// the caller only broadcasts a presence change that happened.
export function dropListener(reviewId: string, id?: number): boolean {
  const held = byReview.get(reviewId);
  if (!held?.target) return false;
  if (id !== undefined && held.id !== id) return false;
  byReview.delete(reviewId);
  held.evict();
  return true;
}
