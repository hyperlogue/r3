import { useQuery } from "@tanstack/react-query";
import { memo, useEffect, useState } from "react";
import { api } from "../api.ts";
import {
  type EnterHandler,
  GUTTER_SELECTED,
  type GutterHandler,
  inSelection,
  useGutterDrag,
} from "../gutter.ts";
import { useSyntaxTheme } from "../settings.ts";
import type { DiffSide, RenderedFile, RenderedFileLine } from "../types.ts";
import { cn, useHtml } from "../ui.tsx";
import { fileViewedKey } from "../viewed.ts";
import { fileScrollKey, VirtualLines } from "../virtual.tsx";
import { FileCard, type FoldSignal } from "./FileCard.tsx";

// Show a line-count stat / start folded past this many lines.
const BIG_FILE_LINES = 1000;

type MdView = "rendered" | "raw";

// Tiny segmented toggle shown in a markdown file's header: rendered HTML vs. the
// raw source (which is still line-anchorable for feedback). Stops click
// propagation so toggling the view doesn't fold the card.
function MdViewToggle({ value, onChange }: { value: MdView; onChange: (v: MdView) => void }) {
  // Outline via an inset ring (box-shadow), not a border: a border adds 2px
  // under border-box and would make this the tallest control in the file header
  // — growing the whole row. The ring adds no layout height, so the toggle
  // matches the sibling "Viewed" pill (same text + py, no border).
  return (
    <div className="flex shrink-0 overflow-hidden rounded ring-1 ring-inset ring-neutral-300 text-[0.625rem] dark:ring-neutral-700">
      {(["rendered", "raw"] as const).map((v) => (
        <button
          key={v}
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onChange(v);
          }}
          className={cn(
            "px-1.5 py-0.5 font-medium capitalize transition-colors",
            value === v
              ? "bg-neutral-200 text-neutral-800 dark:bg-neutral-700 dark:text-neutral-100"
              : "text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200",
          )}
        >
          {v}
        </button>
      ))}
    </div>
  );
}

// Memoized on primitive/stable props (the line is stable from the query cache,
// the handlers are stable from useGutterDrag, `selected` is a boolean), so a
// gutter drag re-renders only the rows whose selection flips — not every line.
const LineRow = memo(function LineRow({
  ln,
  selected,
  onDown,
  onEnter,
}: {
  ln: RenderedFileLine;
  selected: boolean;
  onDown: GutterHandler;
  onEnter: EnterHandler;
}) {
  // Stable `{__html}` wrapper so React 19 doesn't re-set innerHTML (wiping a
  // selection) when the row re-renders on a gutter `selected` flip.
  const html = useHtml(ln.html || "&nbsp;");
  return (
    <div
      // Below md the single 3.5rem gutter compresses to 2.5rem (with px tightened
      // to 1) to give the code more of a phone's width; a 4-digit line number
      // still fits. The gutter pins at left-0, so there's no derived left offset to
      // follow (unlike DiffView's two-column new-side pin).
      className="grid min-w-full grid-cols-[3.5rem_1fr] font-mono text-xs max-md:grid-cols-[2.5rem_1fr]"
      data-line={ln.lineNo}
      data-side="new"
    >
      <span
        data-gutter
        className={cn(
          // Frozen line-number rail: sticky so only the code scrolls
          // horizontally. Must stay opaque — the code slides under it —
          // and painted on the theme surface so it matches the code bg.
          // touch-manipulation so a tap-to-anchor never registers as a double-tap zoom.
          "sticky left-0 z-0 cursor-pointer touch-manipulation border-r border-neutral-300/70 px-2 text-right text-neutral-400 select-none hover:text-neutral-700 max-md:px-1 dark:border-neutral-700 dark:hover:text-neutral-200",
          selected ? GUTTER_SELECTED : "gutter-surface",
        )}
        onMouseDown={(e) => onDown("new", ln.lineNo, e)}
        onMouseEnter={() => onEnter("new", ln.lineNo)}
      >
        {ln.lineNo}
      </span>
      <code className="shiki-code px-2 whitespace-pre" dangerouslySetInnerHTML={html} />
    </div>
  );
});

function CodeBody({
  data,
  path,
  onPickLines,
}: {
  data: RenderedFile;
  path: string;
  onPickLines: (side: DiffSide, lineStart: number, lineEnd: number, quote: string) => void;
}) {
  const g = useGutterDrag({
    textForLine: (_side, n) => data.lines[n - 1]?.text ?? null,
    onPick: (p) => onPickLines(p.side, p.lineStart, p.lineEnd, p.quote),
  });
  const sel = g.selection;
  return (
    <div className="shiki-surface overflow-x-auto">
      {/* One horizontal scrollbar per file: rows share a max-content wrapper (so it
          grows to the widest MOUNTED line) and each row is min-w-full (so short rows
          span the full scroll width). VirtualLines mounts only the on-screen window;
          a files review's lines are contiguous from 1, so index === lineNo - 1 (the
          default resolveIndex) drives scroll-to-line. See DiffView for the same. */}
      <VirtualLines
        className="min-w-max"
        count={data.lines.length}
        itemKey={(i) => data.lines[i].lineNo}
        scrollKey={fileScrollKey(null, path)}
        renderRow={(i) => {
          const ln = data.lines[i];
          return (
            <LineRow
              ln={ln}
              selected={inSelection(sel, "new", ln.lineNo)}
              onDown={g.onDown}
              onEnter={g.onEnter}
            />
          );
        }}
      />
    </div>
  );
}

// Memoized so a parent re-render (e.g. activePath changing on scroll) doesn't
// re-reconcile every file's line rows. `toggle`/`onSha` are stable and `viewed`
// is a per-file boolean the parent computes — so a viewed toggle only flips the
// one card's prop, not every card's (an `isViewed` function prop would get a new
// identity on each toggle and defeat this memo for every file).
function FileViewImpl({
  path,
  refName,
  reviewId,
  snapshotSeq,
  viewed,
  toggle,
  onSha,
  onPickLines,
  onFileFeedback,
  foldSignal,
}: {
  path: string;
  refName: string;
  reviewId: string;
  // When set, render this file's content at that snapshot seq (the from=None
  // browse of a historical snapshot) instead of the live worktree.
  snapshotSeq?: number;
  // Whether this file is marked viewed, computed by the parent (which folds the
  // per-file content-sha key through the viewed set). A plain
  // boolean, not the viewed predicate, so a toggle only changes the one card that
  // flipped rather than re-rendering every memoized card.
  viewed?: boolean;
  // The (stable) viewed toggle; the content-sha key is built here (only this
  // component has the loaded sha). Omit it to hide the toggle entirely (a
  // snapshot-diff / pinned-snapshot browse, where viewed isn't tracked).
  toggle?: (key: string) => void;
  // Report this file's loaded content sha up, so the parent can render a
  // consistent viewed marker in the file-tree (which only knows paths, not shas).
  onSha?: (path: string, sha: string) => void;
  onPickLines: (
    file: string,
    side: DiffSide,
    lineStart: number,
    lineEnd: number,
    quote: string,
  ) => void;
  // Open the composer anchored to this whole file (the header's feedback button).
  onFileFeedback?: (file: string) => void;
  foldSignal?: FoldSignal | null;
}) {
  const syntaxTheme = useSyntaxTheme();
  const [mdView, setMdView] = useState<MdView>("rendered");
  const { data, isLoading, error } = useQuery({
    queryKey: ["blob", reviewId, path, snapshotSeq ?? refName, syntaxTheme],
    queryFn: () =>
      snapshotSeq != null
        ? api.snapshotBlob(reviewId, path, snapshotSeq, syntaxTheme)
        : api.blob(path, refName, syntaxTheme, reviewId),
  });

  // Bubble the content sha up once loaded (and whenever it changes) so the tree's
  // viewed markers stay consistent with this card's. Before the callback exists
  // as a hook-order-safe effect, `data` may be undefined — guard on `data?.sha`.
  useEffect(() => {
    if (data?.sha) onSha?.(path, data.sha);
  }, [data?.sha, path, onSha]);

  // Stable `{__html}` wrapper for the rendered-markdown div — a fresh inline
  // literal makes React 19 re-set innerHTML on every commit, wiping selections.
  // Placed with the hooks, before the early return below, to keep hook order stable.
  const markdownHtml = useHtml(data?.markdownHtml ?? "");

  // Until the blob loads we still render a [data-file] stub so the file browser
  // can scroll to it and active-line highlighting can target it.
  if (!data) {
    return (
      <div data-file={path}>
        <div className="flex h-8 items-center border-b border-neutral-300 bg-neutral-50/95 px-2 font-mono text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900/95">
          {path}
        </div>
        <div className="border-b border-neutral-300 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-950">
          {isLoading && <p className="text-xs text-neutral-400">Loading…</p>}
          {error && <p className="text-xs text-danger-500">{(error as Error).message}</p>}
        </div>
      </div>
    );
  }

  const lineCount = data.lines.length;
  const isMarkdown = data.kind === "markdown";
  // A render fn so the rendered/raw toggle only shows while the card is open.
  const stats = (open: boolean) => (
    <>
      {lineCount > BIG_FILE_LINES && (
        <span className="shrink-0 text-[0.6875rem] font-medium text-neutral-500 dark:text-neutral-400">
          {lineCount.toLocaleString()} lines
        </span>
      )}
      {isMarkdown && open && <MdViewToggle value={mdView} onChange={setMdView} />}
    </>
  );

  return (
    <FileCard
      path={path}
      stats={stats}
      // `viewed` comes from the parent (which keys on the loaded content sha it
      // learns via onSha, so an edited file gets a new key and auto-unfolds).
      // `toggle` builds that same key here (only this card has
      // the sha); absent ⇒ viewed isn't tracked in this view, so the toggle hides.
      viewed={viewed ?? false}
      onToggleViewed={toggle ? () => toggle(fileViewedKey(path, data.sha)) : undefined}
      onFileFeedback={onFileFeedback ? () => onFileFeedback(path) : undefined}
      autoFold={lineCount > BIG_FILE_LINES}
      foldSignal={foldSignal}
    >
      {isMarkdown && mdView === "rendered" ? (
        <div className="r3-markdown px-5 py-3 text-sm" dangerouslySetInnerHTML={markdownHtml} />
      ) : (
        <CodeBody
          data={data}
          path={path}
          onPickLines={(side, ls, le, q) => onPickLines(path, side, ls, le, q)}
        />
      )}
    </FileCard>
  );
}

export const FileView = memo(FileViewImpl);
