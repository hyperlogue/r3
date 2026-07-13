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

import { useState } from "react";
import type { MessageRef } from "../markdown.ts";
import { getSummaryAnchor, type PendingAnchor } from "../selection.ts";
import { Collapse, FoldTriangle } from "../ui.tsx";
import { MessageProse } from "./Message.tsx";

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
  // The human selected text in the review summary. ReviewView routes it through
  // the one applyAnchorGesture (anchor when the composer is empty, "Quote in
  // note" bubble when it holds text) — same as the file pane / round summary.
  // The anchor's quote is the record; the rect positions the bubble.
  onAnchorSummary?: (
    anchor: PendingAnchor,
    quoteText: string,
    rect: { left: number; top: number } | null,
  ) => void;
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
            Review summary
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
            Review summary
          </button>
        </div>
      )}
      <Collapse open={!collapsed}>
        {/* data-summary="review" is the hook useActiveSummaryHighlight targets to
            locate an active summary note's quote (best-effort) and the scope a
            selection anchors within. onMouseUp maps a selection to a summary
            anchor (getSummaryAnchor with a null round = the review summary) and
            hands it to ReviewView's applyAnchorGesture with the selection rect.
            Cap the measure at ~65ch so lines stay a comfortable, readable length
            instead of stretching the full width of a wide review pane. pl lines
            the text up under the label (px-3 + size-2.5 icon + gap-1 = 1.625rem).
            max-h + overflow-y-auto bound the expanded body: this bar is shrink-0
            in ReviewView's flex column, so an unbounded long summary would push
            the file/feedback split off screen — instead it scrolls internally and
            never eats more than half the viewport. */}
        <div
          data-summary="review"
          onMouseUp={(e) => {
            const a = getSummaryAnchor(e.currentTarget, null);
            if (!a) return;
            const sel = window.getSelection();
            const r = sel?.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
            onAnchorSummary?.(
              a,
              a.quote ?? "",
              r ? { left: r.left + r.width / 2, top: r.top } : null,
            );
          }}
          title="Select text to leave feedback on the review summary"
          className="max-h-[50vh] overflow-y-auto"
        >
          <MessageProse
            source={summary.trim()}
            onJumpRef={onJumpRef}
            className="max-w-prose px-3 pb-2 pl-6.5 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300"
          />
        </div>
      </Collapse>
    </div>
  );
}
