// Lazy re-anchor gate: only when a review is dirty (file changed, new feedback,
// or never anchored this daemon lifetime). In-memory; a restart re-anchors on first touch.

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
