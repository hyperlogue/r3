import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  EXPAND_STEP,
  type Gap,
  gapsOf,
  type MergedLines,
  mergeRevealed,
  type RevealMap,
  rangeFor,
} from "../expand.ts";
import {
  type EnterHandler,
  GUTTER_SELECTED,
  type GutterHandler,
  inSelection,
  useGutterDrag,
} from "../gutter.ts";
import type { MessageRef } from "../markdown.ts";
import type { PendingAnchor } from "../selection.ts";
import type { DiffLayout } from "../settings.ts";
import type { DiffFileChange, DiffLine, DiffSide, PatchDiff, PatchMeta } from "../types.ts";
import { cn, Pill, useEscape, useHtml } from "../ui.tsx";
import { diffViewedKey } from "../viewed.ts";
import { fileScrollKey, VirtualLines } from "../virtual.tsx";
import { FileCard, type FoldSignal } from "./FileCard.tsx";
import { SummaryBar } from "./SummaryBar.tsx";

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

// Fetch the unchanged rows for one gap, [start,end] as NEW-side line numbers.
// Resolves to null when the source can't cover the range (the caller then leaves
// the gap as it was), so a failed expand degrades to "nothing happened".
export type FetchContext = (file: string, start: number, end: number) => Promise<DiffLine[] | null>;

// A file with no expandable gaps: the merge is the identity, and the empty map
// means every hunk row renders as the plain `@@` separator it always did.
const NO_GAPS = new Map<DiffLine, { gap: Gap; hidden: number }>();
const EMPTY_MERGE = (lines: DiffLine[]): MergedLines => ({ lines, gapFor: NO_GAPS });

// The row grid shared by the hunk row and the normal row. --gutter-w is the
// single source of the gutter column width: the two grid columns and
// GutterCell's sticky new-side pin (left-[var(--gutter-w)]) all read it, so the
// pin structurally tracks the width at every breakpoint instead of a separate
// left-* literal kept in lockstep by hand. Below md the columns compress
// (3rem → 2.25rem, 96px → 72px on a phone) to give the code more of the narrow
// screen; a 4-digit line number still fits at GutterCell's tightened px.
const ROW_GRID =
  "grid min-w-full [--gutter-w:3rem] max-md:[--gutter-w:2.25rem] grid-cols-[var(--gutter-w)_var(--gutter-w)_1fr] font-mono text-xs";

// The split (side-by-side) row grid: ONE gutter, not two — each half shows only
// its own side's numbers, so the second column the unified grid spends on the
// other side's rail becomes code width. Same --gutter-w so the two layouts line
// up at every breakpoint and GutterCell's px tightening still applies.
const SPLIT_ROW_GRID =
  "grid min-w-full [--gutter-w:3rem] max-md:[--gutter-w:2.25rem] grid-cols-[var(--gutter-w)_1fr] font-mono text-xs";

// One gutter line-number cell: click to anchor feedback on that line, drag to
// extend. Empty (no number on this side) cells are inert. `selected` is
// precomputed by the parent from the live selection (a boolean, so memoized rows
// don't re-render on unrelated drag steps).
function GutterCell({
  line,
  side,
  selected,
  bg,
  pinClass,
  onDown,
  onEnter,
}: {
  line: number | null;
  side: DiffSide;
  selected: boolean;
  bg: string;
  // Where this rail freezes within its own horizontal scroll container. Unified
  // stacks both rails in one container, so the new side pins one column in
  // (the default below); a split half owns its container and pins at left-0.
  pinClass?: string;
  onDown: GutterHandler;
  onEnter: EnterHandler;
}) {
  return (
    <span
      className={cn(
        // Frozen line-number rail: sticky so only the code scrolls horizontally.
        // The new side pins at exactly one column width — left reads the same
        // --gutter-w the row grid (ROW_GRID) declares, so it stays glued to the
        // old column at every breakpoint. px tightens below md so a 4-digit line
        // number still fits the compressed cell. Must stay opaque — the code
        // slides *under* it as it scrolls. touch-manipulation so a tap-to-anchor
        // never registers as a double-tap zoom.
        "sticky z-0 touch-manipulation select-none border-r border-neutral-300/70 px-1 text-right text-neutral-400 max-md:px-0.5 dark:border-neutral-700",
        pinClass ?? (side === "old" ? "left-0" : "left-[var(--gutter-w)]"),
        line != null && "cursor-pointer hover:text-neutral-700 dark:hover:text-neutral-200",
        selected ? GUTTER_SELECTED : bg,
      )}
      onMouseDown={line != null ? (e) => onDown(side, line, e) : undefined}
      onMouseEnter={line != null ? () => onEnter(side, line) : undefined}
    >
      {line ?? ""}
    </span>
  );
}

// The contents of a hunk separator. Without a gap it's the plain `@@` text this
// row has always shown; with one it becomes the expander — chevrons revealing a
// step at either end, and the label revealing the whole gap. The arrow points at
// where the new lines will appear: ⌃ adds them above the bar, ⌄ below it.
//
// Must stay ONE line tall: the virtualizer sizes every row identically (a fixed
// estimate, no measureElement), so a taller bar would drift scroll-to-line.
function HunkBar({
  ln,
  entry,
  onExpand,
}: {
  ln: DiffLine;
  entry?: { gap: Gap; hidden: number };
  onExpand?: (gap: Gap, edge: "top" | "bottom" | "all") => void;
}) {
  if (!entry || !onExpand) return <span className="truncate">{ln.text}</span>;
  const { gap, hidden } = entry;
  const btn =
    "px-1 leading-none rounded hover:bg-neutral-500/20 hover:text-neutral-700 dark:hover:text-neutral-200";
  return (
    <span className="flex items-center gap-1">
      <button
        type="button"
        title={`Show ${EXPAND_STEP} lines above`}
        className={btn}
        onClick={() => onExpand(gap, "top")}
      >
        ⌃
      </button>
      <button
        type="button"
        title={`Show ${EXPAND_STEP} lines below`}
        className={btn}
        onClick={() => onExpand(gap, "bottom")}
      >
        ⌄
      </button>
      <button
        type="button"
        title="Show all unchanged lines here"
        className="truncate rounded px-1 leading-none hover:bg-neutral-500/20 hover:text-neutral-700 dark:hover:text-neutral-200"
        onClick={() => onExpand(gap, "all")}
      >
        {hidden} unchanged {hidden === 1 ? "line" : "lines"}
      </button>
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
  gapEntry,
  onExpand,
  onDown,
  onEnter,
}: {
  ln: DiffLine;
  oldSel: boolean;
  newSel: boolean;
  gapEntry?: { gap: Gap; hidden: number };
  onExpand?: (gap: Gap, edge: "top" | "bottom" | "all") => void;
  onDown: GutterHandler;
  onEnter: EnterHandler;
}) {
  // Stable `{__html}` wrapper so React 19 doesn't re-set innerHTML (wiping a
  // selection) when the row re-renders on a gutter `selected` flip.
  const html = useHtml(ln.html || "&nbsp;");
  if (ln.type === "hunk") {
    return (
      <div className={cn(ROW_GRID, ROW_BG.hunk)}>
        {/* No vertical padding: virtualization sizes every row at one line height
            (a fixed estimate), so a taller hunk row would drift scroll-to-line. */}
        <div className="col-span-3 truncate px-3 select-none">
          <HunkBar ln={ln} entry={gapEntry} onExpand={onExpand} />
        </div>
      </div>
    );
  }
  // anchor side: add/context live on the new side, del on the old side
  const side: DiffSide = ln.type === "del" ? "old" : "new";
  const line = ln.type === "del" ? ln.oldLine : ln.newLine;
  const gutterBg = GUTTER_BG[ln.type];
  return (
    <div className={cn(ROW_GRID, ROW_BG[ln.type])} data-line={line ?? undefined} data-side={side}>
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

// ---- side-by-side (split) layout ----

// One row of the split view: either a full-width hunk separator, or a pair of
// lines shown across the two halves. Either half of a pair can be null — that's
// the filler cell opposite an unmatched add/del (inert, no line number).
type SplitRow =
  | { kind: "hunk"; ln: DiffLine }
  | { kind: "pair"; old: DiffLine | null; new: DiffLine | null };

// Pair a unified row list into split rows. `context` pairs with itself (one
// DiffLine shown on both sides); within a hunk a maximal run of `del` rows zips
// against the run of `add` rows immediately following it (del[i] opposite
// add[i]), and the shorter run pads with nulls. That zip is what makes a
// rewritten line read as old-vs-new on one row instead of two stacked ones.
//
// Deliberately positional, not a re-diff: the server already decided what
// changed, and re-matching here could disagree with the line numbers every
// anchor, pin and highlight is keyed on.
function pairRows(lines: DiffLine[]): SplitRow[] {
  const out: SplitRow[] = [];
  for (let i = 0; i < lines.length; ) {
    const ln = lines[i];
    if (ln.type === "hunk") {
      out.push({ kind: "hunk", ln });
      i++;
      continue;
    }
    if (ln.type === "context") {
      out.push({ kind: "pair", old: ln, new: ln });
      i++;
      continue;
    }
    // A change block: the del run, then the add run that follows it. Either can
    // be empty (a pure addition or a pure deletion).
    const dels: DiffLine[] = [];
    while (i < lines.length && lines[i].type === "del") dels.push(lines[i++]);
    const adds: DiffLine[] = [];
    while (i < lines.length && lines[i].type === "add") adds.push(lines[i++]);
    const n = Math.max(dels.length, adds.length);
    for (let k = 0; k < n; k++) {
      out.push({ kind: "pair", old: dels[k] ?? null, new: adds[k] ?? null });
    }
  }
  return out;
}

// One side of one split row. Carries `data-line`/`data-side` itself — in split
// the unified row div no longer exists, and every consumer (highlights.ts's row
// lookup + region sweep, pane.ts's retrying jump, selection.ts's pointFrom)
// resolves those attributes by closest/querySelector rather than by position, so
// moving them down to the half is transparent to all of them.
const SplitHalfRow = memo(function SplitHalfRow({
  row,
  side,
  selected,
  gapEntry,
  onExpand,
  onDown,
  onEnter,
}: {
  row: SplitRow;
  side: DiffSide;
  selected: boolean;
  gapEntry?: { gap: Gap; hidden: number };
  onExpand?: (gap: Gap, edge: "top" | "bottom" | "all") => void;
  onDown: GutterHandler;
  onEnter: EnterHandler;
}) {
  const ln = row.kind === "hunk" ? row.ln : side === "old" ? row.old : row.new;
  // Stable {__html} wrapper, same reason as the unified Row: React 19 must not
  // re-set innerHTML (wiping a live selection) on a `selected` flip.
  const html = useHtml(ln?.html || "&nbsp;");

  if (row.kind === "hunk") {
    // Painted in BOTH halves so the two independently-scrolling columns keep the
    // same vertical rhythm; only the old (left) half shows the @@ text, so the
    // separator reads as one bar rather than a doubled label.
    return (
      <div className={cn(SPLIT_ROW_GRID, ROW_BG.hunk)}>
        <div className="col-span-2 truncate px-3 select-none">
          {/* Controls live in the left half only — never two expanders per gap. */}
          {side === "old" ? <HunkBar ln={row.ln} entry={gapEntry} onExpand={onExpand} /> : " "}
        </div>
      </div>
    );
  }

  // A filler cell opposite an unmatched add/del: no line, no sign, no tint — the
  // surface shows through so the eye reads "nothing here on this side".
  if (!ln) {
    return (
      <div className={cn(SPLIT_ROW_GRID, "bg-neutral-500/[0.06]")}>
        <GutterCell
          line={null}
          side={side}
          selected={false}
          bg={GUTTER_BG.context}
          pinClass="left-0"
          onDown={onDown}
          onEnter={onEnter}
        />
        <code className="shiki-code px-2 whitespace-pre">&nbsp;</code>
      </div>
    );
  }

  const line = side === "old" ? ln.oldLine : ln.newLine;
  return (
    <div
      className={cn(SPLIT_ROW_GRID, ROW_BG[ln.type])}
      data-line={line ?? undefined}
      data-side={side}
    >
      <GutterCell
        line={line}
        side={side}
        selected={selected}
        bg={GUTTER_BG[ln.type]}
        pinClass="left-0"
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
  layout,
  fetchContext,
  toggle,
  onPickLines,
  onFileFeedback,
  foldSignal,
}: {
  f: DiffFileChange;
  patchSeq: number;
  viewed: boolean;
  layout: DiffLayout;
  // Fetch the unchanged rows for one gap. Absent ⇒ no expanders, whatever the
  // payload claims (the demo, and any caller with no route to ask).
  fetchContext?: FetchContext;
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
  // Expand-context. `reveal` holds the rows fetched per gap; `merged` splices
  // them back into one row list, which EVERYTHING below derives from — the text
  // maps, the index maps, the split pairing, the virtualizer's count. Deriving
  // any of them from `f.lines` instead would let a gutter drag across revealed
  // rows build a quote with lines silently missing (see expand.ts).
  const [reveal, setReveal] = useState<RevealMap>({});
  const gaps = useMemo(() => (fetchContext ? gapsOf(f.lines) : []), [f.lines, fetchContext]);
  const { lines: effectiveLines, gapFor } = useMemo(
    () => (gaps.length ? mergeRevealed(f.lines, gaps, reveal) : EMPTY_MERGE(f.lines)),
    [f.lines, gaps, reveal],
  );
  // A new payload (a round switch, a snapshot from/to change, a refetch)
  // invalidates what was revealed. `generation` also fences fetches that were
  // already in flight: FileBlock is keyed `${seq}:${path}`, and a files review's
  // snapshot diff always carries the SAME synthetic seq, so switching from/to
  // reuses this component — a late reply would otherwise splice the previous
  // pair's rows (old text, old numbers) into the new diff as if they were the file.
  const generation = useRef(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: f.lines identity IS the reset signal
  useEffect(() => {
    generation.current++;
    setReveal({});
  }, [f.lines]);

  // One in-flight fetch per gap: a second click before the first resolves would
  // compute its range against a stale `reveal` and append the same rows twice.
  const inFlight = useRef(new Set<string>());
  const expand = useCallback(
    async (gap: Gap, edge: "top" | "bottom" | "all") => {
      if (!fetchContext || inFlight.current.has(gap.key)) return;
      const range = rangeFor(gap, reveal[gap.key], edge);
      if (!range) return;
      const gen = generation.current;
      inFlight.current.add(gap.key);
      let rows: DiffLine[] | null = null;
      try {
        rows = await fetchContext(f.path, range.start, range.end);
      } finally {
        inFlight.current.delete(gap.key);
      }
      if (!rows?.length || gen !== generation.current) return;
      setReveal((prev) => {
        const cur = prev[gap.key] ?? { top: [], bottom: [] };
        // Re-check the edge lengths inside the updater: between the fetch
        // resolving and this commit a second click could have landed, and
        // appending both replies would duplicate rows.
        if (
          cur.top.length !== (reveal[gap.key]?.top.length ?? 0) ||
          cur.bottom.length !== (reveal[gap.key]?.bottom.length ?? 0)
        )
          return prev;
        // "all" closes the gap in one go, so it lands wholly on the top edge.
        return {
          ...prev,
          [gap.key]:
            edge === "bottom"
              ? { top: cur.top, bottom: [...rows, ...cur.bottom] }
              : { top: [...cur.top, ...rows], bottom: cur.bottom },
        };
      });
    },
    [fetchContext, f.path, reveal],
  );

  // Per-side line text (so a gutter range yields the exact quote — the anchor of
  // record) and per-side line→row-index maps (so scroll-to-line can reach a
  // virtualized-away pinned row). Rebuilt only when the merged rows change.
  const { oldText, newText, oldIdx, newIdx } = useMemo(() => {
    const oldText = new Map<number, string>();
    const newText = new Map<number, string>();
    const oldIdx = new Map<number, number>();
    const newIdx = new Map<number, number>();
    effectiveLines.forEach((ln, i) => {
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
  }, [effectiveLines]);

  // Split rows + their own per-side line→row-index maps. Both halves render the
  // same paired list, so one index map serves both — and scroll-to-line resolves
  // against the layout actually on screen.
  const { splitRows, splitOldIdx, splitNewIdx } = useMemo(() => {
    if (layout !== "split")
      return { splitRows: [] as SplitRow[], splitOldIdx: null, splitNewIdx: null };
    const splitRows = pairRows(effectiveLines);
    const splitOldIdx = new Map<number, number>();
    const splitNewIdx = new Map<number, number>();
    splitRows.forEach((row, i) => {
      if (row.kind !== "pair") return;
      if (row.old?.oldLine != null) splitOldIdx.set(row.old.oldLine, i);
      if (row.new?.newLine != null) splitNewIdx.set(row.new.newLine, i);
    });
    return { splitRows, splitOldIdx, splitNewIdx };
  }, [effectiveLines, layout]);

  const g = useGutterDrag({
    textForLine: (side, n) => (side === "old" ? oldText : newText).get(n) ?? null,
    onPick: (p) => onPickLines(f.path, p.side, p.lineStart, p.lineEnd, p.quote, patchSeq),
  });
  const sel = g.selection;
  // Map a source (line, side) to this list's row index for scroll-to-line; a
  // null side (shouldn't happen in a diff) prefers the new side.
  const resolveIndex = useCallback(
    (line: number, side: DiffSide | null) => {
      const [primary, fallback] =
        splitOldIdx && splitNewIdx
          ? [side === "old" ? splitOldIdx : splitNewIdx, splitOldIdx]
          : [side === "old" ? oldIdx : newIdx, oldIdx];
      return primary.get(line) ?? (side == null ? (fallback.get(line) ?? null) : null);
    },
    [oldIdx, newIdx, splitOldIdx, splitNewIdx],
  );

  // Confine a drag-selection to the half it starts in. Stamping the wrapper on
  // mousedown — before the drag can extend — lets one CSS rule (main.css) make
  // the opposite half unselectable, so the cross-column range never forms rather
  // than being repaired afterwards. Imperative on purpose: a re-render mid-drag
  // would disturb the very selection being made.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const beginSelect = useCallback((side: DiffSide) => {
    const el = wrapRef.current;
    if (!el) return;
    el.setAttribute("data-selecting", side);
    const clear = () => {
      el.removeAttribute("data-selecting");
      window.removeEventListener("mouseup", clear);
    };
    window.addEventListener("mouseup", clear);
  }, []);

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
      ) : layout === "split" ? (
        // Two independently-scrolling halves. They stay vertically locked for
        // free: VirtualLines sizes every row at a FIXED height (no
        // measureElement — virtual.tsx) and both instances read the same pane as
        // their scroll element over the same row count, so they mount identical
        // windows. Only the left registers scrollKey — the paired row index is
        // the same on both sides, so one registration serves both jumps.
        <div ref={wrapRef} className="shiki-surface flex">
          {(["old", "new"] as const).map((side) => (
            <div
              key={side}
              data-split-half={side}
              onMouseDown={() => beginSelect(side)}
              className={cn(
                "w-1/2 min-w-0 overflow-x-auto",
                side === "new" && "border-l border-neutral-300 dark:border-neutral-700",
              )}
            >
              <VirtualLines
                className="min-w-max"
                count={splitRows.length}
                itemKey={(i) => i}
                scrollKey={side === "old" ? fileScrollKey(patchSeq, f.path) : undefined}
                resolveIndex={side === "old" ? resolveIndex : undefined}
                renderRow={(i) => {
                  const row = splitRows[i];
                  const ln = row.kind === "pair" ? (side === "old" ? row.old : row.new) : null;
                  return (
                    <SplitHalfRow
                      row={row}
                      side={side}
                      gapEntry={row.kind === "hunk" ? gapFor.get(row.ln) : undefined}
                      onExpand={expand}
                      selected={inSelection(
                        sel,
                        side,
                        (side === "old" ? ln?.oldLine : ln?.newLine) ?? null,
                      )}
                      onDown={g.onDown}
                      onEnter={g.onEnter}
                    />
                  );
                }}
              />
            </div>
          ))}
        </div>
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
            count={effectiveLines.length}
            itemKey={(i) => i}
            scrollKey={fileScrollKey(patchSeq, f.path)}
            resolveIndex={resolveIndex}
            renderRow={(i) => {
              const ln = effectiveLines[i];
              return (
                <Row
                  ln={ln}
                  oldSel={inSelection(sel, "old", ln.oldLine)}
                  newSel={inSelection(sel, "new", ln.newLine)}
                  gapEntry={gapFor.get(ln)}
                  onExpand={expand}
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

  useEscape(open, () => setOpen(false));

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
  if (!round.summary) return null;
  // The chrome is the shared SummaryBar (one implementation with ReviewSummary,
  // so the two bars are the same h-8 height in every state and can't drift);
  // this wrapper binds the round's data: refs resolve against this round, the
  // anchor names the round's seq, and — the round being immutable — its
  // summary quote never drifts.
  return (
    <SummaryBar
      label="Diff summary"
      source={round.summary}
      collapseKey={ROUND_SUMMARY_COLLAPSE_KEY}
      roundSeq={round.seq}
      expandTitle="Expand round summary"
      collapseTitle="Collapse round summary"
      selectTitle="Select text to leave feedback on this round's summary"
      onAnchorSummary={onAnchorSummary}
      onJumpRef={(ref) => onJumpRef?.(ref, round.seq)}
    />
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
  layout = "unified",
  fetchContext,
  toggle,
  onPickLines,
  onFileFeedback,
  foldSignal,
}: {
  rounds: PatchDiff[];
  // How to render each file: one interleaved column, or two parallel old/new
  // columns. A pure display choice — the payload, the anchors, and every
  // callback shape are identical either way. Defaults to unified so stories and
  // the demo need no wiring.
  layout?: DiffLayout;
  // Fetch a gap's unchanged rows. Omitted ⇒ no expanders anywhere in this view —
  // which is what a caller with no route to ask (the demo, stories) wants.
  fetchContext?: FetchContext;
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
          layout={layout}
          fetchContext={fetchContext}
          toggle={toggle}
          onPickLines={onPickLines}
          onFileFeedback={onFileFeedback}
          foldSignal={foldSignal}
        />
      ))}
    </section>
  );
}
