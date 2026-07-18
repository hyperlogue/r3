import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { useGutterDrag } from "../gutter.ts";
import type { MessageRef } from "../markdown.ts";
import { getSummaryAnchor, type PendingAnchor } from "../selection.ts";
import type { DiffFileChange, DiffLine, DiffSide, PatchDiff, PatchMeta } from "../types.ts";
import { Collapse, cn, FoldTriangle, Pill } from "../ui.tsx";
import { diffViewedKey } from "../viewed.ts";
import { fileScrollKey, VirtualLines } from "../virtual.tsx";
import { FileCard, type FoldSignal } from "./FileCard.tsx";
import { MessageProse } from "./Message.tsx";

// One global preference (like the review summary's own collapse): fold a round
// summary and it stays folded as you move between rounds and reviews.
const ROUND_SUMMARY_COLLAPSE_KEY = "r3-round-summary-collapsed";

// A diff whose file has more rendered rows than this starts folded (still
// expandable). Matches the files-view threshold (BIG_FILE_LINES) so "fold
// anything over ~1000 lines" holds for both diffs and whole-file views.
const AUTOFOLD_ROWS = 1000;

// Row tints are translucent overlays so the theme's own surface (set on the
// scroll container) shows through — add/del read as green/red regardless of
// whether the theme background is light, dark, or Nord-blue. context is bare (the
// surface shows as-is); hunk is a faint neutral bar. Deliberately STOCK
// green/red (the universal diff convention), not the theme's success/danger —
// diff coloring is not a status statement (see the palette note in main.css).
const ROW_BG: Record<string, string> = {
  add: "bg-green-500/15",
  del: "bg-red-500/15",
  context: "",
  hunk: "bg-neutral-500/12 text-neutral-500 dark:text-neutral-400",
};

// The frozen (sticky) gutter MUST be opaque — the code scrolls under it — so it
// can't use the translucent row overlay. These classes (main.css) paint the
// theme surface, blending a slightly stronger green/red for add/del so the number
// rail reads a touch brighter than the code it labels. context = the bare surface.
const GUTTER_BG: Record<string, string> = {
  add: "gutter-add",
  del: "gutter-del",
  context: "gutter-surface",
};

const SIGN: Record<string, string> = { add: "+", del: "−", context: " ", hunk: "" };

type GutterHandler = (side: DiffSide, line: number, e: React.MouseEvent) => void;
type EnterHandler = (side: DiffSide, line: number) => void;

// One gutter line-number cell: click to anchor feedback on that line, drag to
// extend. Empty (no number on this side) cells are inert. `selected` is
// precomputed by the parent from the live selection (a boolean, so memoized rows
// don't re-render on unrelated drag steps).
function GutterCell({
  line,
  side,
  selected,
  bg,
  onDown,
  onEnter,
}: {
  line: number | null;
  side: DiffSide;
  selected: boolean;
  bg: string;
  onDown: GutterHandler;
  onEnter: EnterHandler;
}) {
  return (
    <span
      className={cn(
        // Frozen line-number rail: sticky so only the code scrolls horizontally.
        // The old/new columns are 3rem each, so the new-side gutter pins at 3rem.
        // Must stay opaque — the code slides *under* it as it scrolls.
        "sticky z-0 select-none border-r border-neutral-300/70 px-1 text-right text-neutral-400 dark:border-neutral-700",
        side === "old" ? "left-0" : "left-12",
        line != null && "cursor-pointer hover:text-neutral-700 dark:hover:text-neutral-200",
        selected ? "bg-primary-200 text-primary-900 dark:bg-primary-800 dark:text-primary-100" : bg,
      )}
      onMouseDown={line != null ? (e) => onDown(side, line, e) : undefined}
      onMouseEnter={line != null ? () => onEnter(side, line) : undefined}
    >
      {line ?? ""}
    </span>
  );
}

// Memoized on primitive/stable props (the line object is stable from the diff
// payload, the handlers are stable from useGutterDrag, and the selected flags
// are booleans), so a drag re-renders only the rows whose selection flips.
const Row = memo(function Row({
  ln,
  oldSel,
  newSel,
  onDown,
  onEnter,
}: {
  ln: DiffLine;
  oldSel: boolean;
  newSel: boolean;
  onDown: GutterHandler;
  onEnter: EnterHandler;
}) {
  // Stable `{__html}` wrapper so React 19 doesn't re-set innerHTML (wiping a
  // selection) when the row re-renders on a gutter `selected` flip.
  const html = useMemo(() => ({ __html: ln.html || "&nbsp;" }), [ln.html]);
  if (ln.type === "hunk") {
    return (
      <div
        className={cn("grid min-w-full grid-cols-[3rem_3rem_1fr] font-mono text-xs", ROW_BG.hunk)}
      >
        {/* No vertical padding: virtualization sizes every row at one line height
            (a fixed estimate), so a taller hunk row would drift scroll-to-line. */}
        <div className="col-span-3 truncate px-3 select-none">{ln.text}</div>
      </div>
    );
  }
  // anchor side: add/context live on the new side, del on the old side
  const side: DiffSide = ln.type === "del" ? "old" : "new";
  const line = ln.type === "del" ? ln.oldLine : ln.newLine;
  const gutterBg = GUTTER_BG[ln.type];
  return (
    <div
      className={cn("grid min-w-full grid-cols-[3rem_3rem_1fr] font-mono text-xs", ROW_BG[ln.type])}
      data-line={line ?? undefined}
      data-side={side}
    >
      <GutterCell
        line={ln.oldLine}
        side="old"
        selected={oldSel}
        bg={gutterBg}
        onDown={onDown}
        onEnter={onEnter}
      />
      <GutterCell
        line={ln.newLine}
        side="new"
        selected={newSel}
        bg={gutterBg}
        onDown={onDown}
        onEnter={onEnter}
      />
      <code className="shiki-code px-2 whitespace-pre">
        <span className="mr-1 select-none text-neutral-400">{SIGN[ln.type]}</span>
        <span dangerouslySetInnerHTML={html} />
      </code>
    </div>
  );
});

// Memoized so a parent re-render (activePath/scroll) doesn't re-reconcile every
// diff row. Takes the path-binding callbacks straight from the parent (stable
// refs) and binds f.path itself, so memo isn't defeated by per-row closures.
const FileBlock = memo(function FileBlock({
  f,
  patchSeq,
  viewed,
  toggle,
  onPickLines,
  onFileFeedback,
  foldSignal,
}: {
  f: DiffFileChange;
  patchSeq: number;
  viewed: boolean;
  // Stable across renders; the per-round key is built here (not by the parent) so
  // the incoming props stay memo-stable. Absent ⇒ viewed isn't tracked.
  toggle?: (key: string) => void;
  onPickLines: (
    file: string,
    side: DiffSide,
    lineStart: number,
    lineEnd: number,
    quote: string,
    patchSeq: number,
  ) => void;
  // Open the composer anchored to this whole file within this round (no span).
  onFileFeedback?: (file: string, patchSeq: number) => void;
  foldSignal?: FoldSignal | null;
}) {
  // Per-side line text (so a gutter range yields the exact quote — the anchor of
  // record) and per-side line→row-index maps (so scroll-to-line can reach a
  // virtualized-away pinned row). Rebuilt only when the diff payload changes.
  const { oldText, newText, oldIdx, newIdx } = useMemo(() => {
    const oldText = new Map<number, string>();
    const newText = new Map<number, string>();
    const oldIdx = new Map<number, number>();
    const newIdx = new Map<number, number>();
    f.lines.forEach((ln, i) => {
      if (ln.type === "hunk") return;
      if (ln.oldLine != null) {
        oldText.set(ln.oldLine, ln.text);
        oldIdx.set(ln.oldLine, i);
      }
      if (ln.newLine != null) {
        newText.set(ln.newLine, ln.text);
        newIdx.set(ln.newLine, i);
      }
    });
    return { oldText, newText, oldIdx, newIdx };
  }, [f.lines]);
  const g = useGutterDrag({
    textForLine: (side, n) => (side === "old" ? oldText : newText).get(n) ?? null,
    onPick: (p) => onPickLines(f.path, p.side, p.lineStart, p.lineEnd, p.quote, patchSeq),
  });
  const sel = g.selection;
  // Map a source (line, side) to this list's row index for scroll-to-line; a
  // null side (shouldn't happen in a diff) prefers the new side.
  const resolveIndex = useCallback(
    (line: number, side: DiffSide | null) => {
      const primary = side === "old" ? oldIdx : newIdx;
      return primary.get(line) ?? (side == null ? (oldIdx.get(line) ?? null) : null);
    },
    [oldIdx, newIdx],
  );

  const stats = (
    <>
      {/* "modified" is the common case — only badge the notable statuses
          (added / deleted / renamed) to cut noise. */}
      {f.status !== "modified" && (
        <Pill className="bg-neutral-200 dark:bg-neutral-800">{f.status}</Pill>
      )}
      {f.additions > 0 && (
        <span className="shrink-0 text-[0.6875rem] font-semibold text-green-600 dark:text-green-400">
          +{f.additions}
        </span>
      )}
      {f.deletions > 0 && (
        <span className="shrink-0 text-[0.6875rem] font-semibold text-red-600 dark:text-red-400">
          −{f.deletions}
        </span>
      )}
    </>
  );

  return (
    <FileCard
      path={f.path}
      stats={stats}
      viewed={viewed}
      onToggleViewed={toggle ? () => toggle(diffViewedKey(patchSeq, f.path)) : undefined}
      onFileFeedback={onFileFeedback ? () => onFileFeedback(f.path, patchSeq) : undefined}
      autoFold={f.lines.length > AUTOFOLD_ROWS}
      foldSignal={foldSignal}
    >
      {f.binary ? (
        <div className="px-3 py-2 text-xs text-neutral-400">Binary file not shown.</div>
      ) : (
        <div className="shiki-surface overflow-x-auto">
          {/* One horizontal scrollbar per file: rows share a max-content wrapper
              (so it grows to the widest MOUNTED line) and each row is min-w-full (so
              short rows + their background span the full scroll width). VirtualLines
              mounts only the on-screen window; rows are keyed by position (a diff
              interleaves old/new/hunk rows) and scroll-to-line maps (line,side) →
              row index via resolveIndex. */}
          <VirtualLines
            className="min-w-max"
            count={f.lines.length}
            itemKey={(i) => i}
            scrollKey={fileScrollKey(patchSeq, f.path)}
            resolveIndex={resolveIndex}
            renderRow={(i) => {
              const ln = f.lines[i];
              const oldSel =
                sel != null &&
                sel.side === "old" &&
                ln.oldLine != null &&
                ln.oldLine >= sel.lo &&
                ln.oldLine <= sel.hi;
              const newSel =
                sel != null &&
                sel.side === "new" &&
                ln.newLine != null &&
                ln.newLine >= sel.lo &&
                ln.newLine <= sel.hi;
              return (
                <Row
                  ln={ln}
                  oldSel={oldSel}
                  newSel={newSel}
                  onDown={g.onDown}
                  onEnter={g.onEnter}
                />
              );
            }}
          />
        </div>
      )}
    </FileCard>
  );
});

// The "diff N" pill — mirrors the round badge. Primary-tinted when it names the
// active round, muted otherwise (an inactive row in the dropdown list).
function RoundBadge({ seq, active = true }: { seq: number; active?: boolean }) {
  return (
    <span
      className={cn(
        "shrink-0 whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[0.6875rem] font-semibold",
        active
          ? "bg-primary-100 text-primary-700 dark:bg-primary-950 dark:text-primary-300"
          : "bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300",
      )}
    >
      diff {seq}
    </span>
  );
}

// A micro-badge marking the newest round, styled like the "approved" status
// badge (success green) so "latest" reads as the same class of tag.
function LatestBadge() {
  return (
    <span className="shrink-0 rounded border border-success-500 px-1 py-px text-[0.5625rem] font-semibold uppercase leading-none text-success-700 dark:text-success-300">
      latest
    </span>
  );
}

// Diff-round switcher for a multi-round review: a compact dropdown that lives at
// the right end of the pane toolbar (replacing the old full-width tab strip). The
// trigger shows the active round's "diff N" pill + label; the newest round wears
// a "latest" badge — in the trigger when it's the one selected, and on its row in
// the list. Same popover mechanics as SettingsPopup (click-catcher + Escape).
export function RoundSelect({
  rounds,
  activeSeq,
  onSelect,
}: {
  rounds: PatchMeta[];
  activeSeq: number | null;
  onSelect: (seq: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const latestSeq = rounds[rounds.length - 1]?.seq;
  const active = rounds.find((r) => r.seq === activeSeq) ?? rounds[rounds.length - 1];

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!active) return null;

  return (
    // `flex` so the trigger stretches to the toolbar slot's full height (its
    // wrapper cancels the toolbar's own padding) — that makes the left divider run
    // the whole top-to-bottom line and the hover fill the top/bottom/right space.
    // Below md the slot is the toolbar's full-width first row, so the trigger
    // truly fills it: no width cap, no left divider (there's nothing to divide
    // from), and the chevron pushed to the far right edge. min-w-0 down the
    // wrapper→trigger chain lets the label truncate instead of propagating its
    // full min-content width up and overflowing the row (and the viewport).
    <div className="relative flex min-w-0 max-md:flex-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title="Switch diff round"
        // Embedded into the pane toolbar, not a floating pill: a full-height left
        // divider (no box, no rounding) with only inner padding. While the menu is
        // open, desaturate + dim the trigger so the eye lands on the menu's rows.
        className={cn(
          "flex min-w-0 max-w-[18rem] items-center gap-1.5 border-l border-neutral-300 pl-1.5 pr-1.5 text-xs text-neutral-600 transition duration-150 hover:bg-neutral-100 max-md:flex-1 max-md:max-w-none max-md:border-l-0 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800",
          open && "opacity-60 grayscale",
        )}
      >
        <RoundBadge seq={active.seq} />
        {active.label && <span className="truncate text-neutral-500">{active.label}</span>}
        {active.seq === latestSeq && <LatestBadge />}
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className={cn(
            "ml-0.5 size-3.5 shrink-0 text-neutral-400 transition-transform max-md:ml-auto",
            open && "rotate-180",
          )}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {/* click-catcher: closes the dropdown when clicking elsewhere. Only mounted
          while open, so it never swallows clicks once the menu has animated shut. */}
      {open && (
        <button
          type="button"
          aria-label="Close round switcher"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 cursor-default"
        />
      )}
      {/* Flush under the trigger and exactly its width (inset-x-0 spans the
          relative wrapper, the button's width): a squared-off panel — no
          border/rounding/gap — that reads as the button dropping open, not a
          floating pill. What lifts it off the code behind it is a raised surface
          (a step lighter than the neutral-950 chrome in dark) plus a deep shadow,
          not an outline. Kept mounted (inert + non-interactive while closed) so
          the toggle animates *both* ways — a fade + a short slide-down. */}
      <div
        inert={!open}
        className={cn(
          "absolute inset-x-0 top-full z-50 max-h-80 overflow-y-auto bg-white shadow-2xl transition-[opacity,transform] duration-150 ease-out dark:bg-neutral-800",
          open ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0",
        )}
      >
        {rounds.map((round) => {
          const isActive = round.seq === active.seq;
          return (
            <button
              key={round.seq}
              type="button"
              onClick={() => {
                onSelect(round.seq);
                setOpen(false);
              }}
              title={round.label ?? `diff ${round.seq}`}
              className={cn(
                // Left padding matches the trigger's (pl-1.5) so a row's "diff N"
                // badge lines up under the trigger's badge.
                "flex w-full items-center gap-1.5 py-1.5 pl-1.5 pr-2.5 text-left text-xs transition-colors",
                isActive
                  ? "bg-neutral-100 dark:bg-neutral-700"
                  : "hover:bg-neutral-50 dark:hover:bg-neutral-700/60",
              )}
            >
              <RoundBadge seq={round.seq} active={isActive} />
              <span className="min-w-0 flex-1 truncate text-neutral-600 dark:text-neutral-300">
                {round.label ?? `diff ${round.seq}`}
              </span>
              {round.seq === latestSeq && <LatestBadge />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// The active round's summary — prose set at append time (immutable, like the
// round), distinct from the short `label` title. Extracted from DiffView so
// ReviewView owns the mount point: desktop docks it at the top of the scroll
// pane above the file blocks; mobile mounts it as the pane toolbar's middle row
// (between the round switcher and the buttons). It follows the review summary's
// type treatment (same prose size/color, same fold affordance);
// `data-round-summary` + `data-summary="round"` are the locate/highlight hooks
// (document-scoped — the mobile mount lives outside the scroll pane).
export function RoundSummary({
  round,
  onAnchorSummary,
  onJumpRef,
}: {
  round: PatchMeta;
  // A selection in the summary, routed through ReviewView's applyAnchorGesture
  // (anchor when the composer is empty, "Quote in note" when it holds text) —
  // the anchor carries the summary sentinel + this round's seq, the quote is the
  // record, the rect positions the bubble.
  onAnchorSummary?: (
    anchor: PendingAnchor,
    quoteText: string,
    rect: { left: number; top: number } | null,
  ) => void;
  // An `@path:Lx-y` ref clicked in the summary — resolved against this round.
  onJumpRef?: (ref: MessageRef, patchSeq: number) => void;
}) {
  // Folds like the review summary — one global preference, default expanded
  // (collapse it only if a prior session stored "1").
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem(ROUND_SUMMARY_COLLAPSE_KEY) === "1",
  );
  const toggleCollapsed = () => {
    setCollapsed((c) => {
      const next = !c;
      localStorage.setItem(ROUND_SUMMARY_COLLAPSE_KEY, next ? "1" : "0");
      return next;
    });
  };
  if (!round.summary) return null;
  // Mirrors ReviewSummary's structure exactly so the two bars are the same
  // height in every state — h-8 rows, matching the pane toolbar and the file
  // headers, so the stacked bars read as one consistent header stack.
  return (
    <div
      data-round-summary={round.seq}
      className="border-b border-neutral-300 dark:border-neutral-700"
    >
      {collapsed ? (
        // Collapsed: the entire bar is the expand affordance, with a one-line
        // preview of the summary (same shape as the review summary's bar).
        <button
          type="button"
          onClick={toggleCollapsed}
          title="Expand round summary"
          className="group flex h-8 w-full items-center gap-1.5 px-3 text-left"
        >
          <span className="flex shrink-0 items-center gap-1 text-[0.625rem] font-semibold uppercase tracking-wide text-neutral-400 group-hover:text-neutral-600 dark:group-hover:text-neutral-300">
            <FoldTriangle open={false} />
            Diff summary
          </span>
          <span className="max-w-prose truncate text-[0.6875rem] text-neutral-400 dark:text-neutral-500">
            {round.summary.replace(/\s+/g, " ")}
          </span>
        </button>
      ) : (
        <div className="flex h-8 items-center gap-1.5 px-3">
          <button
            type="button"
            onClick={toggleCollapsed}
            title="Collapse round summary"
            // Muted while expanded, like the review summary's label — it recedes
            // and the prose below is what reads.
            className="flex items-center gap-1 text-[0.625rem] font-semibold uppercase tracking-wide text-neutral-400 hover:text-neutral-600 dark:text-neutral-500 dark:hover:text-neutral-300"
          >
            <FoldTriangle open={true} />
            Diff summary
          </button>
        </div>
      )}
      <Collapse open={!collapsed}>
        {/* Markdown-rendered like the review summary (same MessageProse
            treatment — headings/lists/code + clickable @refs resolved against
            this round). A selection anchors by quote (getSummaryAnchor), routed
            through applyAnchorGesture with the selection rect — the round is
            immutable, so a round-summary quote never drifts. max-h bounds the
            body like the review summary's: the mobile mount sits above the
            scroll pane, where an unbounded summary would crowd out the code. */}
        <div
          data-summary="round"
          onMouseUp={(e) => {
            const a = getSummaryAnchor(e.currentTarget, round.seq);
            if (!a) return;
            const sel = window.getSelection();
            const r = sel?.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
            onAnchorSummary?.(
              a,
              a.quote ?? "",
              r ? { left: r.left + r.width / 2, top: r.top } : null,
            );
          }}
          title="Select text to leave feedback on this round's summary"
          className="max-h-[50vh] overflow-y-auto"
        >
          <MessageProse
            source={round.summary}
            onJumpRef={(ref) => onJumpRef?.(ref, round.seq)}
            className="max-w-prose px-3 pb-2 text-sm leading-relaxed text-neutral-700 dark:text-neutral-300"
          />
        </div>
      </Collapse>
    </div>
  );
}

// A diff review's content: its stored rounds are independent,
// immutable patches — line numbers needn't agree across rounds — so every round
// gets its own [data-round] scope: feedback anchors and reply pins resolve
// (round, file, line), never just (file, line). Only the round named by
// `activeSeq` is rendered; the caller (ReviewView) drives the selection through
// the RoundSelect switcher (and mounts the round's summary — RoundSummary —
// itself). With a single round there's no switcher and this looks exactly like
// a plain single-diff review.
export function DiffView({
  rounds,
  activeSeq,
  isViewed,
  toggle,
  onPickLines,
  onFileFeedback,
  foldSignal,
}: {
  rounds: PatchDiff[];
  // Which round to show. Defaults to the latest round when unset/unmatched.
  activeSeq?: number | null;
  // Viewed-state as content-identity predicates. Keyed per
  // round via diffViewedKey, so a mark in round 1 doesn't carry into round 2.
  // Omit both to render without a viewed toggle (e.g. a files review's derived
  // snapshot-diff, where viewed isn't tracked).
  isViewed?: (key: string) => boolean;
  toggle?: (key: string) => void;
  onPickLines: (
    file: string,
    side: DiffSide,
    lineStart: number,
    lineEnd: number,
    quote: string,
    patchSeq: number,
  ) => void;
  // Called from a file header's feedback button to anchor a note to the whole
  // file within the given round (no line span).
  onFileFeedback?: (file: string, patchSeq: number) => void;
  // The pane toolbar's fold/unfold-all broadcast, passed through to every file.
  foldSignal?: FoldSignal | null;
}) {
  if (rounds.length === 0 || rounds.every((r) => r.files.length === 0)) {
    return <p className="p-6 text-sm text-neutral-400">No changes in this review.</p>;
  }
  const round = rounds.find((r) => r.seq === activeSeq) ?? rounds[rounds.length - 1];
  return (
    <section key={round.seq} data-round={round.seq}>
      {round.files.length === 0 && (
        <p className="px-3 py-2 text-xs text-neutral-400">(empty round)</p>
      )}
      {round.files.map((f) => (
        <FileBlock
          key={`${round.seq}:${f.path}`}
          f={f}
          patchSeq={round.seq}
          viewed={isViewed?.(diffViewedKey(round.seq, f.path)) ?? false}
          toggle={toggle}
          onPickLines={onPickLines}
          onFileFeedback={onFileFeedback}
          foldSignal={foldSignal}
        />
      ))}
    </section>
  );
}
