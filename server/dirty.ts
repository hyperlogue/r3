// Lazy re-anchoring gate (perf). Re-anchoring a mutable review (WORKING/STAGED/
// SCRATCH) re-reads every anchored file and re-searches each quote — worth doing
// only when the content actually changed, not on every detail fetch (a reply, a
// status flip, or any incidental refetch would otherwise pay for it). So
// buildReviewDetail re-anchors only when a review is *dirty*: the file watcher
// marks it on a content change, feedback writes mark it (a new note needs its
// first anchor pass), and a review not yet anchored this daemon lifetime counts
// as dirty — so a first load (or a change made while the daemon was down) still
// re-anchors once. In-memory only: a restart re-anchors everything on first touch,
// which is exactly what we want.

const dirty = new Set<string>();
const anchoredOnce = new Set<string>();

// Mark a review as needing a re-anchor pass (content may have changed).
export function markDirty(reviewId: string): void {
  dirty.add(reviewId);
}

// Whether buildReviewDetail should run reanchorReview for this review.
export function needsReanchor(reviewId: string): boolean {
  return dirty.has(reviewId) || !anchoredOnce.has(reviewId);
}

// Record that a re-anchor pass just ran (clears dirty, marks anchored-once).
export function markAnchored(reviewId: string): void {
  dirty.delete(reviewId);
  anchoredOnce.add(reviewId);
}

// Drop a deleted review's entries so these in-memory sets don't grow unbounded
// over a long daemon lifetime (call on review/repo delete).
export function forget(reviewId: string): void {
  dirty.delete(reviewId);
  anchoredOnce.delete(reviewId);
}
