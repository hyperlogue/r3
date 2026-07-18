import { useState } from "react";
import type { MessageRef } from "../markdown.ts";
import { getSummaryAnchor, type PendingAnchor } from "../selection.ts";
import { Collapse, cn, FoldTriangle } from "../ui.tsx";
import { MessageProse } from "./Message.tsx";

// The one collapsible summary bar — ReviewSummary and DiffView's RoundSummary
// are thin wrappers over this, so the two bars can't drift apart: same h-8
// collapsed/expanded chrome (matching the pane toolbar and file headers, so the
// stacked bars read as one header stack), same one-line preview, same
// MessageProse body with select-to-feedback wiring. What differs is data:
// label, collapse-preference key, wrapper skin, and which summary the anchor
// names (`roundSeq` null = the review summary, a number = that round — it
// drives the data-summary scope, the data-round-summary locate hook, and
// getSummaryAnchor's argument).
export function SummaryBar({
  label,
  source,
  collapseKey,
  className,
  roundSeq = null,
  expandTitle,
  collapseTitle,
  selectTitle,
  onAnchorSummary,
  onJumpRef,
}: {
  label: string;
  // The summary markdown, pre-trimmed by the caller.
  source: string;
  // localStorage key for the fold preference — one global preference per bar
  // kind (not per-review/round): once you collapse summaries, they stay
  // collapsed as you move around, like the sidebar's collapse state.
  collapseKey: string;
  // Wrapper skin on top of the shared border-b (bg, shrink-0).
  className?: string;
  roundSeq?: number | null;
  expandTitle: string;
  collapseTitle: string;
  // The body's tooltip ("Select text to leave feedback on …").
  selectTitle: string;
  // A selection in the prose, routed through ReviewView's applyAnchorGesture
  // (anchor when the composer is empty, "Quote in note" when it holds text) —
  // the anchor's quote is the record, the rect positions the bubble.
  onAnchorSummary?: (
    anchor: PendingAnchor,
    quoteText: string,
    rect: { left: number; top: number } | null,
  ) => void;
  // An `@path:Lx-y` ref clicked in the prose — the caller binds the version it
  // resolves against (null/live for the review summary, the round for a round).
  onJumpRef?: (ref: MessageRef) => void;
}) {
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(collapseKey) === "1");
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(collapseKey, next ? "1" : "0");
      return next;
    });
  };

  return (
    <div
      data-round-summary={roundSeq ?? undefined}
      className={cn("border-b border-neutral-300 dark:border-neutral-700", className)}
    >
      {collapsed ? (
        // Collapsed: the entire bar is the expand affordance (not just the
        // label), with a one-line preview capped at max-w-prose.
        <button
          type="button"
          onClick={toggleCollapsed}
          title={expandTitle}
          className="group flex h-8 w-full items-center gap-1.5 px-3 text-left"
        >
          <span className="flex shrink-0 items-center gap-1 text-[0.625rem] font-semibold uppercase tracking-wide text-neutral-400 group-hover:text-neutral-600 dark:group-hover:text-neutral-300">
            <FoldTriangle open={false} />
            {label}
          </span>
          <span className="max-w-prose truncate text-[0.6875rem] text-neutral-400 dark:text-neutral-500">
            {source.replace(/\s+/g, " ")}
          </span>
        </button>
      ) : (
        <div className="flex h-8 items-center gap-1.5 px-3">
          <button
            type="button"
            onClick={toggleCollapsed}
            title={collapseTitle}
            // Muted while expanded — the label recedes and the prose below is
            // what reads.
            className="flex items-center gap-1 text-[0.625rem] font-semibold uppercase tracking-wide text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300"
          >
            <FoldTriangle open={true} />
            {label}
          </button>
        </div>
      )}
      <Collapse open={!collapsed}>
        {/* data-summary is the locate/highlight hook (useActiveSummaryHighlight)
            and the scope a selection anchors within. onMouseUp maps a selection
            to a summary anchor (getSummaryAnchor with roundSeq) and hands it to
            ReviewView's applyAnchorGesture with the selection rect. The prose is
            width-capped at max-w-prose for a readable measure; px-3 lines it up
            under the fold triangle. max-h + overflow-y-auto bound the expanded
            body so an unbounded summary can't push the pane off screen — it
            scrolls internally instead. */}
        <div
          data-summary={roundSeq == null ? "review" : "round"}
          onMouseUp={(e) => {
            const a = getSummaryAnchor(e.currentTarget, roundSeq);
            if (!a) return;
            const sel = window.getSelection();
            const r = sel?.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
            onAnchorSummary?.(
              a,
              a.quote ?? "",
              r ? { left: r.left + r.width / 2, top: r.top } : null,
            );
          }}
          title={selectTitle}
          className="max-h-[50vh] overflow-y-auto"
        >
          <MessageProse
            source={source}
            onJumpRef={onJumpRef}
            className="max-w-prose px-3 pb-2 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300"
          />
        </div>
      </Collapse>
    </div>
  );
}
