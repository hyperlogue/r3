// Coalesce a burst of query invalidations into one refetch per key.
//
// A single write ripples into several invalidations that all target the same
// query: the mutation's own `onSettled` invalidate, plus the SSE echo of that
// write — which the daemon sends as *two* events (`feedback-updated` AND
// `review-updated`, see server/reviews.ts), each of which the SSE handler turns
// into an `invalidateQueries(["review", id])`. Left alone, resolving one feedback
// fired three identical `GET /api/reviews/:id`.
//
// These invalidations land within a few milliseconds of each other but across
// separate event-loop turns (the PATCH's promise callback, then two EventSource
// message tasks), so React Query's in-flight dedup only catches them when the
// fetches happen to overlap. A short fixed batch window collapses them
// deterministically instead: the first invalidation opens the window and schedules
// the flush; every invalidation inside it just accumulates its key; the flush fires
// one `invalidateQueries` per distinct key. The reconcile is invisible behind the
// optimistic UI, so the sub-frame delay costs nothing — and a continuous event
// stream flushes once per window (bounded refetch rate) rather than starving on a
// resetting debounce.

import type { QueryClient } from "@tanstack/react-query";

// One animation frame's worth — long enough to span the onSettled → SSE gap on
// loopback, short enough to stay imperceptible on a live/watched review.
const COALESCE_MS = 16;

let timer: ReturnType<typeof setTimeout> | null = null;
// Keyed by the serialized query key so repeats within a window collapse; there is a
// single QueryClient per app, so stashing the latest reference is safe.
const pending = new Map<string, { qc: QueryClient; queryKey: readonly unknown[] }>();

export function coalesceInvalidate(qc: QueryClient, queryKey: readonly unknown[]): void {
  pending.set(JSON.stringify(queryKey), { qc, queryKey });
  if (timer != null) return;
  timer = setTimeout(() => {
    timer = null;
    const batch = [...pending.values()];
    pending.clear();
    for (const { qc: client, queryKey: key } of batch) {
      client.invalidateQueries({ queryKey: key });
    }
  }, COALESCE_MS);
}
