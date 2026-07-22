import { type MouseEvent as ReactMouseEvent, useState } from "react";
import type { SnapshotMeta, SnapshotRef } from "../types.ts";
import { cn, useEscape } from "../ui.tsx";

// The version picker for a snapshotted files review, docked in the
// pane toolbar's right slot the way RoundSelect is for a diff review. One dropdown
// lists every version — each captured snapshot as `v<seq>`, plus `Current` (the
// live working content) — oldest at the bottom, newest (Current) at the top.
//
// The view is a range `from → to`: `from = None` shows a plain full-file view of
// `to`; a picked `from` shows the derived diff between the two. Each row carries a
// **from** and a **to** toggle so you set either bound in place; clicking the row
// body is the same as its **to** toggle (the common "show me this version" move).
// A pick that would invert the range (from at/after to) snaps the other bound to
// the neighbouring version so the selection stays a valid oldest→newest span.
// Popover mechanics match RoundSelect (click-catcher + Escape + inert animated
// panel).

type Version = { kind: "snap"; seq: number; label: string | null } | { kind: "current" };

const vName = (v: Version) => (v.kind === "current" ? "Current" : `v${v.seq}`);
const vSub = (v: Version) => (v.kind === "current" ? "live" : v.label);

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn(
        "ml-0.5 size-3.5 shrink-0 text-neutral-400 transition-transform",
        open && "rotate-180",
      )}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

// A from/to toggle chip on a version row. Fixed width so the from and to columns
// line up down the list; filled (primary) when it's the current bound.
function RangeChip({
  label,
  active,
  onClick,
  title,
}: {
  label: string;
  active: boolean;
  onClick: (e: ReactMouseEvent) => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? `Set ${label.toLowerCase()} to this version`}
      className={cn(
        "inline-flex w-11 shrink-0 cursor-pointer items-center justify-center rounded py-0.5 text-[0.625rem] font-semibold leading-none transition-colors",
        active
          ? "bg-primary-600 text-white"
          : "bg-neutral-100 text-neutral-500 hover:bg-neutral-200 dark:bg-neutral-600 dark:text-neutral-200 dark:hover:bg-neutral-500",
      )}
    >
      {label}
    </button>
  );
}

// The full-height 2px rule between the from/to chips and the version label — the
// sole selection indicator (no row-fill highlight). Blue across the selected
// from..to span, gray otherwise.
function dividerClass(selected: boolean): string {
  return cn(
    "-my-1.5 w-[2px] shrink-0 self-stretch",
    selected ? "bg-primary-500" : "bg-neutral-400 dark:bg-neutral-600",
  );
}

export function SnapshotSelect({
  snapshots,
  from,
  to,
  onFromChange,
  onToChange,
}: {
  snapshots: SnapshotMeta[];
  from: number | null; // null = None (no diff — a plain view of `to`)
  to: SnapshotRef; // "WORKING" = the live "Current" version
  onFromChange: (v: number | null) => void;
  onToChange: (v: SnapshotRef) => void;
}) {
  const [open, setOpen] = useState(false);
  useEscape(open, () => setOpen(false));

  // Every version oldest→newest, Current last, so index = rank in the range order
  // (a valid span has from's index < to's index). Sorted defensively; the server
  // returns snapshots in seq order already.
  const ordered: Version[] = [
    ...[...snapshots]
      .sort((a, b) => a.seq - b.seq)
      .map((s) => ({ kind: "snap" as const, seq: s.seq, label: s.label })),
    { kind: "current" as const },
  ];
  const currentPos = ordered.length - 1;
  const posOf = (ref: SnapshotRef | null): number => {
    if (ref === "WORKING") return currentPos;
    if (ref == null) return -1; // None
    return ordered.findIndex((v) => v.kind === "snap" && v.seq === ref);
  };
  const toRefOf = (v: Version): SnapshotRef => (v.kind === "current" ? "WORKING" : v.seq);

  const fromPos = posOf(from);
  const toPos = posOf(to);
  const fromV = fromPos >= 0 ? ordered[fromPos] : null;
  const toV = ordered[toPos] ?? ordered[currentPos];

  // Set `to` to the version at `pos`. If `from` now sits at/after it, the range
  // would invert — snap `from` down to the version just below (or None at the
  // bottom). Clicking the row body routes here (same as the row's `to` chip).
  const selectTo = (pos: number) => {
    if (fromPos >= pos) {
      const below = ordered[pos - 1];
      onFromChange(pos - 1 >= 0 && below.kind === "snap" ? below.seq : null);
    }
    onToChange(toRefOf(ordered[pos]));
  };

  // Set `from` to the snapshot at `pos` (Current can't be a `from`). If `to` now
  // sits at/before it, snap `to` up to the version just above — a snapshot always
  // has Current above it, so that neighbour exists.
  const selectFrom = (pos: number) => {
    const v = ordered[pos];
    if (v.kind !== "snap") return;
    if (toPos <= pos) onToChange(toRefOf(ordered[pos + 1]));
    onFromChange(v.seq);
  };

  return (
    // Below md the slot is the toolbar's full-width first row (same treatment as
    // RoundSelect): the trigger fills it — no width cap, no left divider — with
    // the chevron pushed to the far right edge. min-w-0 down the wrapper→trigger
    // chain lets the version label truncate instead of overflowing the row.
    <div className="relative flex min-w-0 max-md:flex-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Choose which versions to view or diff"
        className={cn(
          "flex min-w-0 max-w-[16rem] items-center gap-1.5 border-l border-neutral-300 pr-1.5 pl-3 text-xs text-neutral-600 transition duration-150 hover:bg-neutral-100 max-md:max-w-none max-md:flex-1 max-md:justify-between max-md:border-l-0 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800",
          open && "opacity-60 grayscale",
        )}
      >
        {fromV == null ? (
          <span className="truncate font-mono">{vName(toV)}</span>
        ) : (
          <span className="truncate font-mono">
            {vName(fromV)} <span className="text-neutral-400">→</span> {vName(toV)}
          </span>
        )}
        <Chevron open={open} />
      </button>

      {open && (
        <button
          type="button"
          aria-label="Close version picker"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 cursor-default"
        />
      )}
      {/* Flush under the trigger (right-aligned; wider than it, so min/max-w
          rather than inset-x-0): a squared-off panel — no border/rounding/gap —
          lifted off the code behind it by a raised surface (a couple steps lighter
          than the neutral-950 chrome in dark) plus a deep shadow, not an outline.
          Kept mounted (inert + non-interactive while closed) so it animates both ways. */}
      <div
        inert={!open}
        className={cn(
          "absolute top-full right-0 z-50 max-h-80 min-w-[17rem] max-w-[24rem] overflow-y-auto bg-white shadow-2xl transition-[opacity,transform] duration-150 ease-out max-md:left-0 max-md:max-w-none dark:bg-neutral-700",
          open ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0",
        )}
      >
        {/* Newest (Current) first; the row body picks `to`, so the menu closes on
            a body click but stays open on the from/to chips for setting a range. */}
        {[...ordered].reverse().map((v, i) => {
          // Reversed for display (newest first); `pos` is the index back in the
          // oldest→newest `ordered`, which the range math below reads.
          const pos = ordered.length - 1 - i;
          const isFrom = v.kind === "snap" && from === v.seq;
          const isTo = toRefOf(v) === to;
          // A version is "in range" when it sits inside the selected span
          // (from..to inclusive) — it turns the divider blue below. from=None
          // sits below v1, so its rank is -1 (posOf(null)); to is always a version.
          const inRange = fromPos <= pos && pos <= toPos;
          const sub = vSub(v);
          return (
            <div
              key={v.kind === "current" ? "current" : `v${v.seq}`}
              className="flex items-center gap-2 py-1.5 pr-3 pl-2.5 text-xs transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-600/60"
            >
              <div className="flex shrink-0 items-center gap-1.5">
                {v.kind === "snap" ? (
                  <RangeChip
                    label="From"
                    active={isFrom}
                    onClick={(e) => {
                      e.stopPropagation();
                      selectFrom(pos);
                    }}
                  />
                ) : (
                  // Current can't be a diff `from`; keep the to column aligned.
                  <span className="w-11 shrink-0" />
                )}
                <RangeChip
                  label="To"
                  active={isTo}
                  onClick={(e) => {
                    e.stopPropagation();
                    selectTo(pos);
                  }}
                />
              </div>
              {/* Full-height rule between the from/to chips and the label; blue
                  when this version is inside the selected span, else gray. */}
              <span aria-hidden="true" className={dividerClass(inRange)} />
              <button
                type="button"
                onClick={() => {
                  selectTo(pos);
                  setOpen(false);
                }}
                className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left"
              >
                <span
                  className={cn(
                    "shrink-0 font-mono font-semibold text-neutral-700 dark:text-neutral-200",
                    // A small pill outline tags the numbered snapshot versions
                    // (v1, v2, …); Current/None read as plain labels.
                    v.kind === "snap" &&
                      "rounded border border-neutral-300 bg-neutral-100 px-1.5 py-0.5 dark:border-neutral-600 dark:bg-neutral-800",
                  )}
                >
                  {vName(v)}
                </span>
                {sub && (
                  <span className="min-w-0 truncate text-neutral-500 dark:text-neutral-400">
                    {sub}
                  </span>
                )}
              </button>
            </div>
          );
        })}
        {/* A dummy "None" option at the very bottom: its only control is a `from`
            chip that clears the lower bound (from = None → a plain, no-diff view
            of `to`). None is never a `to` (the target is always a version or
            Current), so its to column is a spacer. */}
        <div className="flex items-center gap-2 py-1.5 pr-3 pl-2.5 text-xs transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-600/60">
          <div className="flex shrink-0 items-center gap-1.5">
            <RangeChip
              label="From"
              active={from == null}
              title="Diff from nothing — a plain view of the target"
              onClick={(e) => {
                e.stopPropagation();
                onFromChange(null);
              }}
            />
            <span className="w-11 shrink-0" />
          </div>
          {/* None is in range whenever it's the picked lower bound (from=None). */}
          <span aria-hidden="true" className={dividerClass(from == null)} />
          <button
            type="button"
            onClick={() => {
              onFromChange(null);
              setOpen(false);
            }}
            className="flex min-w-0 flex-1 items-baseline gap-1.5 text-left"
          >
            <span className="shrink-0 font-mono font-semibold text-neutral-700 dark:text-neutral-200">
              None
            </span>
            <span className="min-w-0 truncate text-neutral-500 dark:text-neutral-400">no diff</span>
          </button>
        </div>
      </div>
    </div>
  );
}
