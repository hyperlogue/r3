import type { ReactNode } from "react";
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
  sheet,
  onSetSheet,
  children,
}: {
  openCount: number;
  sheet: MobileSheetState;
  onSetSheet: (s: MobileSheetState) => void;
  children: ReactNode; // the FeedbackPanel (fills the sheet: it's h-full flex-col)
}) {
  return (
    <>
      {/* The bar is in-flow at the bottom of ReviewView's column (not fixed), so
          it never overlaps the last code line; safe-area padding clears the home
          indicator. It wears the feedback surface (panel-header white/near-black)
          behind a 2px rule — the desktop dock's border weight — so it reads as
          the feedback panel's edge, not another file-header strip. The whole bar
          is one expand/collapse button — no other controls live here (watcher
          presence shows inside the panel, where Submit is). */}
      <div className="shrink-0 border-t-2 border-neutral-300 bg-white pb-[env(safe-area-inset-bottom)] dark:border-neutral-700 dark:bg-neutral-950">
        <button
          type="button"
          onClick={() => onSetSheet(sheet === "closed" ? "full" : "closed")}
          className="flex min-h-11 w-full items-center gap-2 px-3 text-sm font-semibold"
        >
          {/* Chevron-up: the affordance that this bar expands upward. */}
          <svg
            viewBox="0 0 24 24"
            aria-hidden="true"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={cn(
              "size-4 text-neutral-400 transition-transform duration-200",
              sheet !== "closed" && "rotate-180",
            )}
          >
            <path d="m6 15 6-6 6 6" />
          </svg>
          Feedback
          <span className="font-normal text-neutral-500">· {openCount} open</span>
        </button>
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
        {/* Header strip: borderless, on the panel-header surface so it and the
            FeedbackPanel header right below it read as one unified header. h-11
            gives the two controls a 44px touch target — the expand/shrink button
            spans the whole strip with the grab-handle glyph truly screen-centered
            (absolute — not flexed against the ✕'s leftover space); the ✕ overlays
            the right edge (w-11, so it's a 44px square). */}
        <div className="relative h-11 shrink-0 rounded-t-xl bg-white dark:bg-neutral-950">
          <button
            type="button"
            onClick={() => onSetSheet(sheet === "full" ? "peek" : "full")}
            title={sheet === "full" ? "Shrink — keep the code visible" : "Expand"}
            className="absolute inset-0 rounded-t-xl"
          >
            {/* Grab-handle look, but it's a plain tap target (expand/shrink). */}
            <span className="absolute left-1/2 top-1/2 h-1 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full bg-neutral-300 dark:bg-neutral-600" />
          </button>
          <button
            type="button"
            aria-label="Close feedback"
            onClick={() => onSetSheet("closed")}
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center text-neutral-500"
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1">{children}</div>
      </div>
    </>
  );
}
