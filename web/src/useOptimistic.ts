// Snapshot-and-rollback a ReviewDetail mutation. Cancel in-flight refetches so
// they can't land over the optimistic patch; restore + invalidate on error
// because a failed write has no SSE echo.

import { useQueryClient } from "@tanstack/react-query";
import type { ReviewDetail } from "./types.ts";

export function useOptimisticPatch(reviewId: string) {
  const qc = useQueryClient();
  const reviewKey = ["review", reviewId] as const;
  const beginPatch = async () => {
    await qc.cancelQueries({ queryKey: reviewKey });
    return qc.getQueryData<ReviewDetail>(reviewKey);
  };
  const restore = (prev: ReviewDetail | undefined) => {
    if (prev) qc.setQueryData(reviewKey, prev);
    qc.invalidateQueries({ queryKey: reviewKey });
  };
  return { beginPatch, restore };
}
