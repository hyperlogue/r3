// Per-reviewer "viewed" state. Key is content identity (`d:<seq>:<path>`,
// `f:<path>@<sha>`), so a changed file auto-unfolds.

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
