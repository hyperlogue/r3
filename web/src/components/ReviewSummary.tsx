// A review's short, free-form overview (shared/types.ts `Review.summary`): a
// collapsible "Review summary" bar docked at the top of the file-viewer pane
// (its prose is width-capped, so full-width above the split wasted the right
// side). The summary is **read-only for humans**
// — it's set/cleared only from the CLI (`r3 edit --summary`) — and it's the
// agent's *guide* to the review, so it renders as Markdown with the same message
// treatment feedback/replies get: safe markdown-it (web/src/markdown.ts) plus
// clickable `@path:Lx-y` refs. The summary is edited in place (no version is
// captured, unlike a reply's `ref_version`), so its refs resolve against the
// **live/current view** — ReviewView's onJumpRef with a null version.
//
// Selecting summary text is one *select-to-feedback* gesture, unified with the
// file pane and DiffView's round summary: an empty composer anchors a note to the
// selection (a `@summary`-anchored review-summary note); a composer already
// holding text raises a "Quote in note" bubble instead (never clobbers). Because
// the summary renders as Markdown *and* is edited in place (`r3 edit --summary`),
// a summary anchor has no stable source offsets and can drift — so its quote is
// the anchor of record, the agent can `r3 reanchor` it, and locating it is
// best-effort (find the quote in the rendered prose; accept some drift). ReviewView
// owns the empty-vs-composing decision (applyAnchorGesture) via onAnchorSummary.
//
// The bar chrome itself is the shared SummaryBar (one implementation with
// DiffView's RoundSummary); this wrapper just binds the review-summary data.

import type { MessageRef } from "../markdown.ts";
import type { PendingAnchor } from "../selection.ts";
import { SummaryBar } from "./SummaryBar.tsx";

// One global preference (not per-review): once you collapse summaries, they stay
// collapsed as you move between reviews, like the sidebar's collapse state.
const COLLAPSE_KEY = "r3-summary-collapsed";

export function ReviewSummary({
  summary,
  onJumpRef,
  onAnchorSummary,
}: {
  summary: string | null;
  // An `@path:Lx-y` ref clicked in the summary — ReviewView jumps the pane,
  // resolving against the live/current view (the summary pins no version).
  onJumpRef?: (ref: MessageRef) => void;
  // The human selected text in the review summary — see SummaryBar.
  onAnchorSummary?: (
    anchor: PendingAnchor,
    quoteText: string,
    rect: { left: number; top: number } | null,
  ) => void;
}) {
  // No summary: nothing to show. Humans can't add one (CLI-only), so stay quiet
  // rather than dangling an affordance that does nothing.
  if (!summary?.trim()) return null;

  return (
    <SummaryBar
      label="Review summary"
      source={summary.trim()}
      collapseKey={COLLAPSE_KEY}
      className="shrink-0 bg-neutral-50/60 dark:bg-neutral-900/40"
      expandTitle="Expand summary"
      collapseTitle="Collapse summary"
      selectTitle="Select text to leave feedback on the review summary"
      onAnchorSummary={onAnchorSummary}
      onJumpRef={onJumpRef}
    />
  );
}
