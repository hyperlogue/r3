// A review's short, free-form overview (shared/types.ts `Review.summary`): a
// collapsible bar under the review header. The summary is **read-only for humans**
// — it's set/cleared only from the CLI (`r3 edit --summary`), so the web UI just
// displays it (collapse to reclaim vertical space) and lets you select text to
// anchor feedback to it. Pure + prop-driven, so it's easy to exercise in Storybook.

import { useState } from "react";
import { getSummaryAnchor, type PendingAnchor } from "../selection.ts";
import { Collapse, FoldTriangle } from "../ui.tsx";

// One global preference (not per-review): once you collapse summaries, they stay
// collapsed as you move between reviews, like the sidebar's collapse state.
const COLLAPSE_KEY = "r3-summary-collapsed";

export function ReviewSummary({
  summary,
  onAnchor,
}: {
  summary: string | null;
  // Called when the human selects text in the summary to anchor feedback to it
  // (the anchor carries the review-summary sentinel; patch_seq is null).
  onAnchor?: (anchor: PendingAnchor) => void;
}) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "1");

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      return next;
    });
  };

  // No summary: nothing to show. Humans can't add one (CLI-only), so stay quiet
  // rather than dangling an affordance that does nothing.
  if (!summary?.trim()) return null;

  return (
    <div className="shrink-0 border-b border-neutral-300 bg-neutral-50/60 dark:border-neutral-700 dark:bg-neutral-900/40">
      {collapsed ? (
        // Collapsed: the entire bar is the expand affordance (not just the label),
        // and the one-line preview is capped at max-w-prose with the rest hidden.
        <button
          type="button"
          onClick={toggleCollapsed}
          title="Expand summary"
          className="group flex h-8 w-full items-center gap-1.5 px-3 text-left"
        >
          <span className="flex shrink-0 items-center gap-1 text-[0.625rem] font-semibold uppercase tracking-wide text-neutral-400 group-hover:text-neutral-600 dark:group-hover:text-neutral-300">
            <FoldTriangle open={false} />
            Summary
          </span>
          <span className="max-w-prose truncate text-[0.6875rem] text-neutral-400 dark:text-neutral-500">
            {summary.trim().replace(/\s+/g, " ")}
          </span>
        </button>
      ) : (
        <div className="flex h-8 items-center gap-1.5 px-3">
          <button
            type="button"
            onClick={toggleCollapsed}
            title="Collapse summary"
            className="flex items-center gap-1 text-[0.625rem] font-semibold uppercase tracking-wide text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300"
          >
            <FoldTriangle open={true} />
            Summary
          </button>
        </div>
      )}
      <Collapse open={!collapsed}>
        <p
          data-summary="review"
          onMouseUp={(e) => {
            const a = getSummaryAnchor(e.currentTarget, null);
            if (a) onAnchor?.(a);
          }}
          title="Select text to leave feedback on the summary"
          // Cap the measure at ~65ch so lines stay a comfortable, readable length
          // instead of stretching the full width of a wide review pane. pl lines
          // the text up under the label (px-3 + size-2.5 icon + gap-1 = 1.625rem).
          // Expanded, the prose reads at text-sm (larger than the collapsed
          // one-line preview) since it's the primary thing you're reading here.
          className="max-w-prose whitespace-pre-wrap px-3 pb-2 pl-6.5 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300"
        >
          {summary.trim()}
        </p>
      </Collapse>
    </div>
  );
}
