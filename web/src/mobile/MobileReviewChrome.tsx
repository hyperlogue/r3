import type { ReactNode } from "react";
import type { WatcherInfo } from "../types.ts";
import { cn } from "../ui.tsx";

// The phone-tier review chrome (see AGENTS.md "Mobile"): a persistent bottom
// bar summarizing the feedback state, and a bottom sheet hosting the one
// FeedbackPanel instance. Three discrete states — closed, "peek" (short sheet:
// the composer, which the panel auto-scrolls into view, over the code being
// annotated), "full" (browse/reply/resolve) — every transition a tap, no drag
// physics. The sheet stays mounted across states (panel-internal state — tab,
// optimistic cards, scroll — survives), hidden by transform + `inert`.
//
// This module owns containers only: the panel, its props, and all domain state
// live in ReviewView exactly as on desktop (the prime rule — mobile never
// forks panel/domain state, and desktop components never import from mobile/).

export type MobileSheetState = "closed" | "peek" | "full";

export function MobileReviewChrome({
  openCount,
  watchers,
  sheet,
  onSetSheet,
  children,
}: {
  openCount: number;
  watchers: WatcherInfo[];
  sheet: MobileSheetState;
  onSetSheet: (s: MobileSheetState) => void;
  children: ReactNode; // the FeedbackPanel (fills the sheet: it's h-full flex-col)
}) {
  const watcher = watchers[0];
  return (
    <>
      {/* The bar is in-flow at the bottom of ReviewView's column (not fixed), so
          it never overlaps the last code line; safe-area padding clears the home
          indicator. */}
      <div className="flex shrink-0 items-center justify-between border-t border-neutral-300 bg-white pb-[env(safe-area-inset-bottom)] dark:border-neutral-700 dark:bg-neutral-950">
        <button
          type="button"
          onClick={() => onSetSheet(sheet === "closed" ? "full" : "closed")}
          className="flex min-h-11 flex-1 items-center gap-2 px-3 text-sm font-semibold"
        >
          Feedback
          <span className="font-normal text-neutral-500">
            · {openCount} open{sheet !== "closed" ? " ·  ✕" : ""}
          </span>
        </button>
        {watcher && (
          <span
            className="flex shrink-0 items-center gap-1.5 px-3 text-xs text-neutral-500"
            title={`${watchers.length > 1 ? `${watchers.length} agents` : "agent"} watching — Submit hands your feedback off live`}
          >
            <span className="text-success-500">●</span>
            <span className="max-w-24 truncate">{watcher.session}</span>
            watching
          </span>
        )}
      </div>

      {/* Full-height sheet gets a dimmed click-away backdrop; the peek doesn't —
          the code above it must stay readable and selectable while composing. */}
      {sheet === "full" && (
        <button
          type="button"
          aria-label="Close feedback"
          onClick={() => onSetSheet("closed")}
          className="fixed inset-0 z-40 cursor-default bg-black/30"
        />
      )}
      <div
        inert={sheet === "closed"}
        className={cn(
          "fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-xl border-t border-neutral-300 bg-neutral-50 pb-[env(safe-area-inset-bottom)] shadow-[0_-8px_24px_rgba(0,0,0,0.15)] transition-[transform,height] duration-200 dark:border-neutral-700 dark:bg-neutral-900",
          sheet === "full" ? "h-[92dvh]" : "h-[45dvh]",
          sheet === "closed" && "translate-y-full",
        )}
      >
        <div className="flex shrink-0 items-center justify-between border-b border-neutral-200 px-1.5 dark:border-neutral-800">
          <button
            type="button"
            onClick={() => onSetSheet(sheet === "full" ? "peek" : "full")}
            title={sheet === "full" ? "Shrink — keep the code visible" : "Expand"}
            className="flex min-h-10 flex-1 items-center justify-center"
          >
            {/* Grab-handle look, but it's a plain tap target (expand/shrink). */}
            <span className="h-1 w-8 rounded-full bg-neutral-300 dark:bg-neutral-600" />
          </button>
          <button
            type="button"
            aria-label="Close feedback"
            onClick={() => onSetSheet("closed")}
            className="flex min-h-10 min-w-11 items-center justify-center text-neutral-500"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </>
  );
}
