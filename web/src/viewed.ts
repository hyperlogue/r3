// Per-reviewer "viewed" (read-progress) state, server-backed.
//
// The viewed *key* encodes content identity, so a mark means "I read *this
// content*," not merely "this path": diff rounds are immutable, so a round's file
// is keyed by (round seq, path); live files change under the review, so a file is
// keyed by (path, content sha) — when the file changes its new sha yields a new
// key, the old mark stops matching, and the card auto-unfolds (the "clear on
// update" behavior) with no explicit clearing.

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { api } from "./api.ts";

export const diffViewedKey = (seq: number, path: string) => `d:${seq}:${path}`;
export const fileViewedKey = (path: string, sha: string) => `f:${path}@${sha}`;

const queryKey = (reviewId: string) => ["viewed", reviewId] as const;

// Server-backed viewed set for a review with optimistic writes, so a toggle folds
// the file instantly. Exposes the same isViewed/toggle shape
// the file components already consume — they don't know it's server-persisted.
// No SSE: a second tab reconciles via React Query's refetch-on-focus.
export function useViewedFiles(reviewId: string) {
  const qc = useQueryClient();
  const { data: keys } = useQuery({
    queryKey: queryKey(reviewId),
    queryFn: () => api.getViewed(reviewId),
  });

  const isViewed = useCallback((k: string) => keys?.has(k) ?? false, [keys]);

  const { mutate } = useMutation({
    mutationFn: ({ k, viewed }: { k: string; viewed: boolean }) =>
      api.setViewed(reviewId, k, viewed),
    // Optimistic: flip the cached set now so the fold is instant; roll back on
    // error; reconcile with the server on settle.
    onMutate: async ({ k, viewed }) => {
      await qc.cancelQueries({ queryKey: queryKey(reviewId) });
      const prev = qc.getQueryData<Set<string>>(queryKey(reviewId));
      const next = new Set(prev);
      if (viewed) next.add(k);
      else next.delete(k);
      qc.setQueryData(queryKey(reviewId), next);
      return { prev };
    },
    onError: (_e, _vars, ctx) => {
      if (ctx?.prev) qc.setQueryData(queryKey(reviewId), ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: queryKey(reviewId) }),
  });

  // Stable across renders — reads the current set from the cache instead of
  // closing over `keys`, so handing it to a memoized file block doesn't defeat
  // that block's memo on every viewed change.
  const toggle = useCallback(
    (k: string) => {
      const cur = qc.getQueryData<Set<string>>(queryKey(reviewId));
      mutate({ k, viewed: !(cur?.has(k) ?? false) });
    },
    [qc, reviewId, mutate],
  );

  return { isViewed, toggle };
}
