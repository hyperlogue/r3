import { useQuery } from "@tanstack/react-query";
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ApiError, api } from "../api.ts";
import { type DocLink, docLinkFromEvent, markMissingDocLinks } from "../doclinks.ts";
import {
  type EnterHandler,
  GUTTER_SELECTED,
  type GutterHandler,
  inSelection,
  useGutterDrag,
} from "../gutter.ts";
import { type Region, regionAt } from "../highlights.ts";
import { useSyntaxTheme } from "../settings.ts";
import type { DiffSide, RenderedFile, RenderedFileLine } from "../types.ts";
import { cn, useHtml } from "../ui.tsx";
import { fileViewedKey } from "../viewed.ts";
import { fileScrollKey, VirtualLines } from "../virtual.tsx";
import { FileCard, type FoldSignal } from "./FileCard.tsx";

// Show a line-count stat / start folded past this many lines.
const BIG_FILE_LINES = 1000;
const NO_REGIONS: Region[] = [];

// How long a body survives in the query cache after its last observer goes away —
// i.e. after the file leaves the preload band and FileBody unmounts.
const BLOB_GC_MS = 60_000;

type MdView = "rendered" | "raw";

// A file the review lists that the source no longer has. The blob query resolves
// this instead of throwing, so a 404 is a cached VALUE: an errored query holds no
// data, and TanStack refetches a data-less enabled query on every re-activation
// whatever its staleTime — a review whose branch moved on (half its files gone)
// turned every scroll pass into hundreds of pointless requests. As data it obeys
// staleTime like any body, and the file-changed SSE invalidation of this exact key
// is what picks the file up if it comes back.
interface MissingFile {
  missing: true;
}
type BlobResult = RenderedFile | MissingFile;
const isMissing = (b: BlobResult): b is MissingFile => "missing" in b;

// What the 404 means depends on where the body was going to come from.
function missingLabel(refName: string, snapshotSeq?: number): string {
  if (snapshotSeq != null) return `Not in snapshot ${snapshotSeq}`;
  if (refName === "WORKING") return "Not in the working tree";
  if (refName === "SCRATCH") return "Not in the scratch directory";
  return `Not in ${refName}`;
}

// What the header needs from a body that may not be mounted: the sha the viewed
// key is built from, the line count (the stat + autoFold) and whether the
// rendered/raw toggle applies. Tagged with the ref/snapshot it was read at — a
// version switch replaces the file's content, so the old numbers stop applying.
interface FileMeta {
  version: string;
  sha: string;
  lineCount: number;
  isMarkdown: boolean;
}

const sameMeta = (a: FileMeta | null, b: FileMeta) =>
  a != null &&
  a.version === b.version &&
  a.sha === b.sha &&
  a.lineCount === b.lineCount &&
  a.isMarkdown === b.isMarkdown;

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
// the handlers are stable from useGutterDrag, `selected`/`fbId` are primitives),
// so a gutter drag re-renders only the rows whose selection flips — not every line.
const LineRow = memo(function LineRow({
  ln,
  selected,
  onDown,
  onEnter,
  fbId,
}: {
  ln: RenderedFileLine;
  selected: boolean;
  onDown: GutterHandler;
  onEnter: EnterHandler;
  fbId?: string;
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
      className={cn(
        "grid min-w-full grid-cols-[3.5rem_1fr] font-mono text-xs max-md:grid-cols-[2.5rem_1fr]",
        fbId && "r3-feedback-region",
      )}
      data-line={ln.lineNo}
      data-side="new"
      data-fb-id={fbId}
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
  regions,
}: {
  data: RenderedFile;
  path: string;
  onPickLines: (side: DiffSide, lineStart: number, lineEnd: number, quote: string) => void;
  regions: Region[];
}) {
  const g = useGutterDrag({
    textForLine: (_side, n) => data.lines[n - 1]?.text ?? null,
    onPick: (p) => onPickLines(p.side, p.lineStart, p.lineEnd, p.quote),
  });
  const sel = g.selection;
  const fileRegions = useMemo(
    () => (regions.length === 0 ? regions : regions.filter((r) => r.file === path)),
    [regions, path],
  );
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
              fbId={regionAt(fileRegions, ln.lineNo, "new")?.id}
            />
          );
        }}
      />
    </div>
  );
}

// The expensive half, and the ONLY holder of the blob query — mounted just while
// the file is `active` (near the viewport). An always-mounted observer is what
// used to pin every body ever scrolled past in the cache for the life of the
// review: the gc clock only starts when the last observer goes away.
function FileBody({
  path,
  refName,
  reviewId,
  snapshotSeq,
  headerReady,
  mdView,
  regions,
  hasFile,
  onPickLines,
  onDocLink,
  onSha,
  onHydrated,
  onMeta,
}: {
  path: string;
  refName: string;
  reviewId: string;
  snapshotSeq?: number;
  // Whether the shell has this file's card up yet. Until it does — the very first
  // body, reported below in a layout effect so the card mounts before paint — the
  // body renders only the loading/missing/error chrome: mounting the virtualizer
  // into a wrapper it is about to be moved out of would only measure it twice.
  headerReady: boolean;
  mdView: MdView;
  regions: Region[];
  hasFile?: (path: string) => boolean;
  onPickLines: (
    file: string,
    side: DiffSide,
    lineStart: number,
    lineEnd: number,
    quote: string,
  ) => void;
  onDocLink?: (link: DocLink) => void;
  onSha?: (path: string, sha: string) => void;
  onHydrated?: (ready: boolean) => void;
  onMeta: (meta: Omit<FileMeta, "version">) => void;
}) {
  const syntaxTheme = useSyntaxTheme();
  const { data, isLoading, isFetching, error } = useQuery({
    queryKey: ["blob", reviewId, path, snapshotSeq ?? refName, syntaxTheme],
    queryFn: async (): Promise<BlobResult> => {
      try {
        return snapshotSeq != null
          ? await api.snapshotBlob(reviewId, path, snapshotSeq, syntaxTheme)
          : await api.blob(path, refName, syntaxTheme, reviewId);
      } catch (err) {
        // A file the review lists but the source no longer has: a value, not an
        // error (see MissingFile). Anything else is a real failure and still throws.
        if (err instanceof ApiError && err.status === 404) return { missing: true };
        throw err;
      }
    },
    // Bounded retention, not permanent. A cached body stays fresh forever — the
    // file-change SSE invalidates this exact key, so viewport re-entry never
    // re-runs Shiki + JSON serialization — but it is collected a minute after this
    // component unmounts with the file's body. Highlighted blobs run to megabytes
    // and a large review has hundreds of files, so holding every one ever scrolled
    // past until the review closes grew the heap with the scroll. A re-entry after
    // that refetches, which /api/blob's content ETag answers with a 304.
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: BLOB_GC_MS,
  });
  const file = data != null && !isMissing(data) ? data : null;

  useEffect(() => {
    onHydrated?.((data != null && !isFetching) || error != null);
  }, [data, isFetching, error, onHydrated]);

  // Bubble the content sha up once loaded (and whenever it changes) so the tree's
  // viewed markers stay consistent with this card's.
  useEffect(() => {
    if (file?.sha) onSha?.(path, file.sha);
  }, [file?.sha, path, onSha]);

  // Hand the header what it needs to keep rendering without a body. A LAYOUT
  // effect: the card has to mount in the same commit the body landed in, or the
  // first paint of a loaded file is the header-less stub.
  useLayoutEffect(() => {
    if (!file) return;
    onMeta({ sha: file.sha, lineCount: file.lines.length, isMarkdown: file.kind === "markdown" });
  }, [file, onMeta]);

  // Stable `{__html}` wrapper for the rendered-markdown div — a fresh inline
  // literal makes React 19 re-set innerHTML on every commit, wiping selections.
  // Placed with the hooks, before the early returns below, to keep hook order stable.
  const markdownHtml = useHtml(file?.markdownHtml ?? "");

  // Dim the doc links pointing outside the review, right after React commits the
  // server HTML — hence the dependency on the `{__html}` identity, which is what
  // decides whether that HTML was (re)injected — and again if membership changes
  // under it.
  const mdRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (hasFile && markdownHtml.__html) markMissingDocLinks(mdRef.current, hasFile);
  }, [hasFile, markdownHtml]);

  if (!file) {
    const chrome = (
      <>
        {isLoading && <p className="text-xs text-neutral-400">Loading…</p>}
        {data != null && isMissing(data) && (
          // The row an error takes, in the muted tone: a file the branch deleted
          // under a long-lived review is an expected state, not a failure.
          <p className="text-xs text-neutral-500 dark:text-neutral-400">
            {missingLabel(refName, snapshotSeq)}
          </p>
        )}
        {error && <p className="text-xs text-danger-500">{(error as Error).message}</p>}
      </>
    );
    // The pre-card stub supplies the padded panel; inside a card (a body refetched
    // after collection, or a theme switch) this has to supply its own.
    return headerReady ? <div className="p-3">{chrome}</div> : chrome;
  }
  if (!headerReady) return null;

  return file.kind === "markdown" && mdView === "rendered" ? (
    // The doc-link click is caught here rather than on the pane so it stays
    // next to the missing-link marking above. It always preventDefaults: the
    // anchor's `href="#"` exists only to keep it focusable.
    // biome-ignore lint/a11y/useKeyWithClickEvents: delegated to real <a>s, which fire click on Enter
    <div
      ref={mdRef}
      className="r3-markdown px-5 py-3 text-sm"
      onClick={(e) => {
        const link = docLinkFromEvent(e.target);
        if (!link) return;
        e.preventDefault();
        onDocLink?.(link);
      }}
      dangerouslySetInnerHTML={markdownHtml}
    />
  ) : (
    <CodeBody
      data={file}
      path={path}
      regions={regions}
      onPickLines={(side, ls, le, q) => onPickLines(path, side, ls, le, q)}
    />
  );
}

// Memoized so a parent re-render (e.g. activePath changing on scroll) doesn't
// re-reconcile every file's line rows. `toggle`/`onSha` are stable and `viewed`
// is a per-file boolean the parent computes — so a viewed toggle only flips the
// one card's prop, not every card's (an `isViewed` function prop would get a new
// identity on each toggle and defeat this memo for every file).
//
// The shell outlives the body: it stays mounted for the whole review and keeps the
// card, its fold state, the rendered/raw view and the last body's metadata, while
// FileBody — which owns the query — is mounted only near the viewport.
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
  onDocLink,
  hasFile,
  current,
  foldSignal,
  unscopedFold,
  active = true,
  ownsFileMarker = true,
  onHydrated,
  onOpenChange,
  regions = NO_REGIONS,
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
  // A relative link inside this file's rendered Markdown was clicked: jump the
  // pane to that file (doclinks.ts). `hasFile` says whether a target is part of
  // the review, so the ones that aren't render dead instead of no-oping.
  onDocLink?: (link: DocLink) => void;
  hasFile?: (path: string) => boolean;
  // Marks this as the scroll-spy's current file — what a per-file shortcut acts
  // on. A boolean, not the current path, so a spy move re-renders only the two
  // cards whose flag changed (this component is memoized).
  current?: boolean;
  foldSignal?: FoldSignal | null;
  unscopedFold?: "fold" | "unfold" | null;
  // Large reviews leave every cheap file shell mounted but activate blob fetch +
  // body rendering only near the viewport (ProgressiveFile).
  active?: boolean;
  ownsFileMarker?: boolean;
  onHydrated?: (ready: boolean) => void;
  onOpenChange?: (open: boolean) => void;
  // Unresolved-feedback spans to wash onto matching code rows. Rendered markdown
  // still goes through useRegionHighlight.
  regions?: Region[];
}) {
  const [mdView, setMdView] = useState<MdView>("rendered");
  // The last body's metadata, so the header survives that body's unmount (and a
  // theme switch's refetch) instead of collapsing back to the bare stub.
  const [meta, setMeta] = useState<FileMeta | null>(null);
  const version = String(snapshotSeq ?? refName);
  const file = meta?.version === version ? meta : null;
  const onMeta = useCallback(
    (next: Omit<FileMeta, "version">) =>
      setMeta((prev) => {
        const full = { ...next, version };
        return sameMeta(prev, full) ? prev : full;
      }),
    [version],
  );

  const body = active ? (
    <FileBody
      path={path}
      refName={refName}
      reviewId={reviewId}
      snapshotSeq={snapshotSeq}
      headerReady={file != null}
      mdView={mdView}
      regions={regions}
      hasFile={hasFile}
      onPickLines={onPickLines}
      onDocLink={onDocLink}
      onSha={onSha}
      onHydrated={onHydrated}
      onMeta={onMeta}
    />
  ) : null;

  // No body has landed yet, so there is nothing to build a header from: the
  // loading/missing/error chrome, and the small [data-file] stub ProgressiveFile
  // measures in a large review. FileCard reads its initial fold from autoFold +
  // viewed, both of which need the loaded file, so mounting it earlier would fold
  // long files wrong.
  if (!file) {
    return (
      <div data-file={ownsFileMarker ? path : undefined}>
        <div className="flex h-8 items-center border-b border-neutral-300 bg-neutral-50/95 px-2 font-mono text-xs text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900/95">
          {path}
        </div>
        <div className="border-b border-neutral-300 bg-white p-3 dark:border-neutral-700 dark:bg-neutral-950">
          {body}
        </div>
      </div>
    );
  }

  // A render fn so the rendered/raw toggle only shows while the card is open.
  const stats = (open: boolean) => (
    <>
      {file.lineCount > BIG_FILE_LINES && (
        <span className="shrink-0 text-[0.6875rem] font-medium text-neutral-500 dark:text-neutral-400">
          {file.lineCount.toLocaleString()} lines
        </span>
      )}
      {file.isMarkdown && open && <MdViewToggle value={mdView} onChange={setMdView} />}
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
      onToggleViewed={toggle ? () => toggle(fileViewedKey(path, file.sha)) : undefined}
      onFileFeedback={onFileFeedback ? () => onFileFeedback(path) : undefined}
      autoFold={file.lineCount > BIG_FILE_LINES}
      current={current}
      foldSignal={foldSignal}
      unscopedFold={unscopedFold}
      ownsFileMarker={ownsFileMarker}
      onOpenChange={onOpenChange}
    >
      {body}
    </FileCard>
  );
}

export const FileView = memo(FileViewImpl);
