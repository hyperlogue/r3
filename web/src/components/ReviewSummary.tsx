// A review's short, free-form overview (shared/types.ts `Review.summary`): a
// collapsible bar under the review header. The summary is **read-only for humans**
// — it's set/cleared only from the CLI (`r3 edit --summary`) — and it's the
// agent's *guide* to the review, so it renders as Markdown with the same message
// treatment feedback/replies get: safe markdown-it (web/src/markdown.ts) plus
// clickable `@path:Lx-y` refs. The summary is edited in place (no version is
// captured, unlike a reply's `ref_version`), so its refs resolve against the
// **live/current view** — ReviewView's onJumpRef with a null version.
//
// Selecting summary text raises a "Quote in note" bubble (the same
// selection-to-quote flow as agent replies) that drops the selection into the
// general-feedback composer as a `>` blockquote — summary feedback is a plain
// review-level note now, not a `@summary`-anchored one (rendered markdown has no
// stable source offsets to anchor a quote to; round summaries in DiffView keep
// their plain-text anchor flow).

import { useCallback, useRef, useState } from "react";
import type { MessageRef } from "../markdown.ts";
import { Collapse, FoldTriangle } from "../ui.tsx";
import { MessageProse, QuoteBubble, useQuoteBubble } from "./Message.tsx";

// One global preference (not per-review): once you collapse summaries, they stay
// collapsed as you move between reviews, like the sidebar's collapse state.
const COLLAPSE_KEY = "r3-summary-collapsed";

export function ReviewSummary({
  summary,
  onJumpRef,
  onQuote,
}: {
  summary: string | null;
  // An `@path:Lx-y` ref clicked in the summary — ReviewView jumps the pane,
  // resolving against the live/current view (the summary pins no version).
  onJumpRef?: (ref: MessageRef) => void;
  // The human clicked "Quote in note" on a summary selection — ReviewView drops
  // the text into the general-feedback composer as a `>` blockquote.
  onQuote?: (text: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(COLLAPSE_KEY) === "1");
  const boxRef = useRef<HTMLDivElement>(null);

  // Any selection inside the rendered summary prose is quotable.
  const eligible = useCallback((range: Range) => {
    const n = range.commonAncestorContainer;
    const el = n instanceof Element ? n : n.parentElement;
    return !!el?.closest('[data-summary="review"]');
  }, []);
  const { pos, hide } = useQuoteBubble(boxRef, eligible);
  const quote = (text: string) => {
    onQuote?.(text);
    hide();
    window.getSelection()?.removeAllRanges();
  };

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
    <div
      ref={boxRef}
      className="shrink-0 border-b border-neutral-300 bg-neutral-50/60 dark:border-neutral-700 dark:bg-neutral-900/40"
    >
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
        {/* data-summary="review" is the hook useActiveSummaryHighlight flashes
            when a legacy summary-anchored feedback is activated, and what makes
            a selection here quotable. Cap the measure at ~65ch so lines stay a
            comfortable, readable length instead of stretching the full width of
            a wide review pane. pl lines the text up under the label (px-3 +
            size-2.5 icon + gap-1 = 1.625rem). max-h + overflow-y-auto bound the
            expanded body: this bar is shrink-0 in ReviewView's flex column, so
            an unbounded long summary would push the file/feedback split off
            screen — instead it scrolls internally and never eats more than half
            the viewport. */}
        <div
          data-summary="review"
          title="Select text to quote it in a general note"
          className="max-h-[50vh] overflow-y-auto"
        >
          <MessageProse
            source={summary.trim()}
            onJumpRef={onJumpRef}
            className="max-w-prose px-3 pb-2 pl-6.5 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300"
          />
        </div>
      </Collapse>
      {/* Fixed-positioned off the selection, so it escapes the bar's bounds. */}
      {pos && <QuoteBubble pos={pos} label="Quote in note" onQuote={quote} />}
    </div>
  );
}
