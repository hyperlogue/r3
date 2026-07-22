import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ApiError, api } from "../api.ts";
import { DiffView, RoundSelect, RoundSummary } from "../components/DiffView.tsx";
import { FeedbackPanel } from "../components/FeedbackPanel.tsx";
import { FileBrowser } from "../components/FileBrowser.tsx";
import type { FoldSignal } from "../components/FileCard.tsx";
import { FileView } from "../components/FileView.tsx";
import { JumpToFile } from "../components/JumpToFile.tsx";
import { QuoteBubble, type QuotePos, quoteBlock } from "../components/Message.tsx";
import { PaneToolbar, TOOLBAR_BTN } from "../components/PaneToolbar.tsx";
import { ReviewHeader } from "../components/ReviewHeader.tsx";
import { ReviewSummary } from "../components/ReviewSummary.tsx";
import { SnapshotSelect } from "../components/SnapshotSelect.tsx";
import {
  clearDraft,
  dropAnchor,
  getDraft,
  setDraftAnchor,
  setDraftText,
  useDraftAnchor,
  useHasAnchoredText,
} from "../drafts.ts";
import { sourceLabel } from "../format.ts";
import {
  type Region,
  refineMarkdownClick,
  useActiveLineHighlight,
  useActiveSummaryHighlight,
  useRegionHighlight,
} from "../highlights.ts";
import type { MessageRef } from "../markdown.ts";
// The one sanctioned mobile-module import (see AGENTS.md "Mobile"): ReviewView
// is the single mount point that swaps the desktop side-dock for the phone
// chrome. Everything else mobile is inert max-md:/pointer-coarse: classes.
import { AddFeedbackPill } from "../mobile/AddFeedbackPill.tsx";
import { MobileReviewChrome, type MobileSheetState } from "../mobile/MobileReviewChrome.tsx";
import { useIsMobile } from "../mobile/useIsMobile.ts";
import { usePointerCoarse } from "../mobile/usePointerCoarse.ts";
import { focusComposer, retryScrollToRow, usePaneCrossfade } from "../pane.ts";
import { type Placement, placeInDiff } from "../resolveFeedback.ts";
import { navigate } from "../router.ts";
import { getSelectionAnchor, type PendingAnchor } from "../selection.ts";
import { useSyntaxTheme } from "../settings.ts";
import type {
  DiffSide,
  FeedbackWithReplies,
  PatchDiff,
  ReviewDetail,
  SnapshotRef,
  UpdateReviewBody,
} from "../types.ts";
import { SUMMARY_FILE } from "../types.ts";
import { Button, cn, useResizableWidth } from "../ui.tsx";
import { diffViewedKey, fileViewedKey, useViewedFiles } from "../viewed.ts";
import { fileScrollKey, useVirtualPaneController, VirtualPaneProvider } from "../virtual.tsx";

// A files review's derived snapshot-diff is rendered through DiffView as a single
// synthetic round; this is its [data-round] seq. Feedback in a files review keeps
// patch_seq null (it isn't scoped to a round), so this only scopes the DOM query
// for active-line highlighting — it never reaches the server.
const SNAPSHOT_DIFF_SEQ = 0;

// Mobile: wraps the pane toolbar so it sticks at the pane top (z-20 paints it
// over FileCard's z-10 header) and reports its live height up — the toolbar
// grows/shrinks as the round-summary row expands/collapses or its rows wrap, so
// a ResizeObserver mirrors it; unmounting (desktop, or no toolbar) reports 0.
function StickyToolbar({
  onHeight,
  children,
}: {
  onHeight: (h: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => onHeight(el.offsetHeight));
    ro.observe(el);
    return () => {
      ro.disconnect();
      onHeight(0);
    };
  }, [onHeight]);
  return (
    <div ref={ref} className="sticky top-0 z-20">
      {children}
    </div>
  );
}

export function ReviewView({ reviewId }: { reviewId: string }) {
  const qc = useQueryClient();
  const scopeRef = useRef<HTMLDivElement>(null);
  // Owns the per-file scroll-to-line registry the virtualized code panes fill;
  // ReviewView renders the pane provider as a child, so it can't consume that
  // context and holds the registry here instead (used by the locate/pin jumps).
  const virt = useVirtualPaneController();
  // Fold/unfold broadcast to the file cards: the toolbar's fold-all, and the
  // path-scoped unfolds that a next/prev jump or a feedback-locate fires so a
  // folded target file opens (mounting its rows) before we scroll to its line.
  // A fresh nonce each time so repeating an action overrides hand-toggled folds.
  const [foldSignal, setFoldSignal] = useState<FoldSignal | null>(null);
  const ensureFileOpen = useCallback((path: string) => {
    setFoldSignal((s) => ({ mode: "unfold", nonce: (s?.nonce ?? 0) + 1, path }));
  }, []);
  // The in-progress anchored composer's target, persisted per review in the browser
  // (drafts.ts) so it hides on switch and restores on return. Subscribe to just the
  // anchor (not the whole draft record) so typing in the composer/reply/general
  // note doesn't re-render this whole view — the anchor ref is stable across those
  // edits. The composers own their own text, read straight from the store.
  const pending = useDraftAnchor(reviewId);
  const [activeFbId, setActiveFbId] = useState<string | null>(null);
  // Bumped by an explicit "jump to this feedback" click so re-clicking the
  // already-active feedback still re-scrolls.
  const [scrollNonce, setScrollNonce] = useState(0);
  const [activePath, setActivePath] = useState<string | null>(null);
  // Which diff round (patch) the tab strip has selected, for a multi-round diff
  // review — null until the human picks one, then `effectiveRoundSeq` resolves
  // it (falling back to the latest round). Only one round renders at a time, so
  // this also scopes the file browser + scroll-spy.
  const [activeRoundSeq, setActiveRoundSeq] = useState<number | null>(null);
  // Files-review snapshot picker: `fromSnap` null = None (no diff — a
  // plain view of `toSnap`); `toSnap` "WORKING" = the live content (the default).
  const [fromSnap, setFromSnap] = useState<number | null>(null);
  const [toSnap, setToSnap] = useState<SnapshotRef>("WORKING");
  const { isViewed, toggle: toggleViewed } = useViewedFiles(reviewId);
  // Loaded content shas for the live files view, reported up by each FileView, so
  // the file-tree's viewed markers (keyed by path) stay consistent with the cards'
  // sha-keyed marks. Only populated in the live plain view.
  const [shas, setShas] = useState<Map<string, string>>(new Map());
  const onSha = useCallback((path: string, sha: string) => {
    setShas((prev) => (prev.get(path) === sha ? prev : new Map(prev).set(path, sha)));
  }, []);
  // Drag-resizable feedback panel (right-docked → drag its left edge to widen).
  // Defaults to a golden split (panel = 0.382 of the row, file view = 0.618);
  // double-click the handle to reset.
  const splitRef = useRef<HTMLDivElement>(null);
  const {
    width: feedbackWidth,
    onPointerDown: onFeedbackResize,
    onDoubleClick: onFeedbackResetSplit,
  } = useResizableWidth("r3-feedback-width", {
    min: 280,
    max: 680,
    defaultFraction: 0.382,
    containerRef: splitRef,
  });
  // Phone tier: the side dock and sidebar don't mount; the same FeedbackPanel
  // renders inside the MobileReviewChrome sheet instead (closed / composer-peek
  // / full). All mobile deltas live at this mount-point fork + the sheet-state
  // nudges below — never inside the panel or the domain state.
  const isMobile = useIsMobile();
  const [sheet, setSheet] = useState<MobileSheetState>("closed");
  // Touch anchoring keys on the *pointer*, not the width tier (see usePointerCoarse
  // / AGENTS.md "Mobile"): a coarse pointer swaps the desktop mouseup selection path
  // for the AddFeedbackPill, on either layout tier. `composing` mirrors
  // applyAnchorGesture's own branch so the pill's label tells the truth — an empty
  // composer anchors a note, a composer already holding text quotes the selection in.
  const coarse = usePointerCoarse();
  const hasAnchoredText = useHasAnchoredText(reviewId);
  const composing = pending != null && hasAnchoredText;

  // The mobile-sheet policies, named once (each is an inert no-op on desktop,
  // where the sheet is already — and stays — "closed"): a jump landing in the
  // code pane closes the sheet so the target is visible; an anchor gesture
  // raises the composer *peek*, not the full sheet, so the code being annotated
  // stays on screen while typing; finishing the composer (submit/discard)
  // retires a peek but never collapses a deliberately opened full sheet.
  const closeSheetForJump = useCallback(() => setSheet("closed"), []);
  const peekSheetForCompose = useCallback(() => {
    if (isMobile) setSheet("peek");
  }, [isMobile]);
  const settleSheetAfterCompose = useCallback(
    () => setSheet((s) => (s === "peek" ? "closed" : s)),
    [],
  );

  // Mobile: the pane toolbar sticks at the pane top while the review header +
  // summary above it scroll away, and each FileCard header pins just below it
  // (StickyToolbar reports the live height; the scroll pane publishes it as
  // --pane-sticky-h — FileCard's header `top` and the anchor-in-view test both
  // read it). 0 (var unset) on desktop / with no toolbar.
  const [stickyToolbarH, setStickyToolbarH] = useState(0);

  const {
    data: detail,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["review", reviewId],
    queryFn: () => api.review(reviewId),
    // A deleted review 404s — don't retry it, so the tab reacts promptly (the
    // guard below then swaps in the error screen). Other errors keep retrying.
    retry: (failureCount, err) =>
      err instanceof ApiError && err.status === 404 ? false : failureCount < 3,
  });

  // Live `r3 watch` presence — same query key as FeedbackPanel's, so this shares
  // the cache (no extra request) and only exists to flag watching in the tab title.
  const { data: watchersData } = useQuery({
    queryKey: ["watchers", detail?.id],
    queryFn: () => api.watchers(detail!.id),
    enabled: !!detail,
    refetchInterval: 30000,
    // Keep polling while the tab is hidden so the tab-title "watching" dot tracks
    // an agent that starts/stops watching in the background, where the browser may
    // suspend our SSE stream (the poll then re-syncs it without a tab switch).
    refetchIntervalInBackground: true,
  });
  const watching = (watchersData?.watchers.length ?? 0) > 0;

  const syntaxTheme = useSyntaxTheme();
  const isDiff = detail?.kind === "diff";
  // The review's stored rounds — one query regardless of how many
  // rounds exist; the server falls back to a live render for legacy reviews.
  const { data: diff, error: diffError } = useQuery({
    queryKey: ["review-diff", reviewId, syntaxTheme],
    queryFn: () => api.reviewDiff(reviewId, syntaxTheme),
    enabled: isDiff,
  });
  const rounds = diff?.rounds ?? [];
  // The round the tab strip shows: the human's pick if it still exists, else the
  // latest round (the newest work — what a reviewer coming back wants first). A
  // new round arriving over SSE never yanks an existing selection.
  const effectiveRoundSeq =
    activeRoundSeq != null && rounds.some((r) => r.seq === activeRoundSeq)
      ? activeRoundSeq
      : (rounds[rounds.length - 1]?.seq ?? null);

  // Files-review content snapshots. The from/to picker diffs any two
  // (or one vs. live); with none captured the picker is hidden and the view is the
  // classic live files view. `diffMode` = a `from` snapshot is picked.
  const snapshots = useMemo(() => (detail?.kind === "files" ? detail.snapshots : []), [detail]);
  const snapKey = snapshots.map((s) => s.seq).join(",");
  // Reset a from/to selection that no longer resolves — a snapshot removed, or the
  // review switched under a persisted component — back to None/live.
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapKey encodes the snapshot set the selection must stay within
  useEffect(() => {
    if (fromSnap != null && !snapshots.some((s) => s.seq === fromSnap)) setFromSnap(null);
    if (toSnap !== "WORKING" && !snapshots.some((s) => s.seq === toSnap)) setToSnap("WORKING");
  }, [snapKey]);
  const diffMode = detail?.kind === "files" && fromSnap != null;
  const { data: snapDiff } = useQuery({
    queryKey: ["snapshot-diff", reviewId, fromSnap, toSnap, syntaxTheme],
    queryFn: () => api.snapshotDiff(reviewId, fromSnap as number, toSnap, syntaxTheme),
    enabled: diffMode,
  });
  // The derived diff wrapped as one synthetic round so DiffView renders it (same
  // gutter-drag feedback, folding, side-aware rows) with no round header.
  const snapRounds: PatchDiff[] = useMemo(
    () =>
      snapDiff
        ? [
            {
              seq: SNAPSHOT_DIFF_SEQ,
              label: null,
              summary: null,
              created_at: detail?.created_at ?? "",
              files: snapDiff.files,
            },
          ]
        : [],
    [snapDiff, detail?.created_at],
  );
  // Locate each files-review feedback in the current snapshot-diff by quote:
  // the canonical anchor is the live file, so per-side renumbered diff
  // rows can't be matched by line number — we find the quote among the diff rows.
  const diffPlacements = useMemo(() => {
    const m = new Map<string, Placement>();
    if (!diffMode || !snapDiff || !detail) return m;
    for (const fb of detail.feedback) {
      if (fb.file === SUMMARY_FILE || !fb.file || !fb.quote) continue;
      const p = placeInDiff(snapDiff.files, fb);
      if (p) m.set(fb.id, p);
    }
    return m;
  }, [diffMode, snapDiff, detail]);

  // The selected theme's editor background + default foreground, painted onto the
  // code surfaces (DiffView/FileView) via CSS vars so a theme looks like it does
  // in an editor. Same for every file, so it's fetched once per theme and set on
  // the content pane; descendants inherit. Falls back to the neutral card colour.
  const { data: themeStyle } = useQuery({
    queryKey: ["theme-style", syntaxTheme],
    queryFn: () => api.themeStyle(syntaxTheme),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const surfaceVars = themeStyle
    ? ({
        "--shiki-light-bg": themeStyle.lightBg,
        "--shiki-dark-bg": themeStyle.darkBg,
        "--shiki-light": themeStyle.lightFg,
        "--shiki-dark": themeStyle.darkFg,
      } as CSSProperties)
    : undefined;

  // Derive the active feedback from the live detail by id, so live updates keep
  // it fresh without a sync effect.
  const activeFb: FeedbackWithReplies | null =
    detail?.feedback.find((f) => f.id === activeFbId) ?? null;
  // In a snapshot-diff view the active feedback is placed by quote onto a side of
  // the diff (its stored live line number doesn't apply there); feed the resolved
  // coords to the highlighter. Unplaced → null line so it rings nothing rather than
  // the wrong row. Plain views use the feedback as-is (server-anchored line).
  const activeFbHighlight = useMemo<FeedbackWithReplies | null>(() => {
    if (!activeFb || !diffMode) return activeFb;
    const p = diffPlacements.get(activeFb.id);
    if (!p) return { ...activeFb, line_start: null, line_end: null };
    return {
      ...activeFb,
      side: p.side,
      line_start: p.lineStart,
      line_end: p.lineEnd,
      patch_seq: SNAPSHOT_DIFF_SEQ,
    };
  }, [activeFb, diffMode, diffPlacements]);
  useActiveLineHighlight(scopeRef, activeFbHighlight, scrollNonce, virt.scrollToLine);
  useActiveSummaryHighlight(activeFb, scrollNonce);

  // The version the content pane currently renders: a diff review's active round,
  // else the files review's snapshot from/to selection (covers plain view, a pinned
  // snapshot, and a snapshot-diff). A diff review renders null while its rounds load
  // — skipped so the initial load (and a theme refetch that briefly drops `diff`)
  // doesn't count as a switch; a files selection always maps to a concrete key.
  const paneVersionKey = isDiff
    ? effectiveRoundSeq != null
      ? `d:${effectiveRoundSeq}`
      : null
    : `s:${fromSnap ?? "none"}:${toSnap}`;
  usePaneCrossfade(scopeRef, paneVersionKey);

  // Regions any unresolved (non-resolved) feedback anchors to, for a persistent
  // highlight in the file view. Diff reviews are excluded (side-aware rows).
  const rawRegions = useMemo<Region[]>(() => {
    if (!detail) return [];
    const out: Region[] = [];
    for (const fb of detail.feedback) {
      // Skip resolved and file-less notes, plus summary notes — a summary points at
      // prose (data-summary), not a file's data-line rows, so this can't place it.
      if (fb.status === "resolved" || !fb.file || fb.file === SUMMARY_FILE) continue;
      let start: number;
      let end: number;
      let side: Region["side"];
      if (detail.kind === "diff") {
        // Diff review: feedback anchors into an immutable stored round (patch_seq +
        // line/side). Only one round renders at a time and line numbers don't carry
        // across rounds, so mark only the round on screen; the rest stay listed in
        // the panel but unmarked here.
        if (fb.patch_seq !== effectiveRoundSeq || fb.line_start == null) continue;
        start = fb.line_start;
        end = fb.line_end ?? fb.line_start;
        side = fb.side;
      } else if (diffMode) {
        // Files review, snapshot-diff view: place by quote, onto the side it lands
        // on. Feedback whose quote isn't in this diff is listed, not marked.
        const p = diffPlacements.get(fb.id);
        if (!p) continue;
        start = p.lineStart;
        end = p.lineEnd;
        side = p.side;
      } else {
        // Files review, plain view: the server-anchored line (live content, or
        // approximate for a historical snapshot browse). All rows are one side.
        if (fb.line_start == null) continue;
        start = fb.line_start;
        end = fb.line_end ?? fb.line_start;
        side = undefined;
      }
      out.push({ id: fb.id, file: fb.file, start, end, quote: fb.quote ?? "", side });
    }
    return out;
  }, [detail, diffMode, diffPlacements, effectiveRoundSeq]);
  // The regions recompute on every `detail` change (any SSE reply/status flip),
  // but their identity feeds useRegionHighlight's full DOM sweep. Stabilize it:
  // keep the previous array whenever the new one is structurally identical, so
  // the sweep only re-runs when the regions actually change. The digest is the
  // region tuples the sweep reads (id, file, line span, side, quote).
  const regionsKey = useMemo(
    () =>
      rawRegions
        .map((r) => `${r.id}\t${r.file}\t${r.start}\t${r.end}\t${r.side ?? ""}\t${r.quote}`)
        .join("\n"),
    [rawRegions],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: regionsKey is a structural digest of rawRegions — re-memoize only when the content changes, not on every new array identity
  const unresolvedRegions = useMemo(() => rawRegions, [regionsKey]);
  useRegionHighlight(scopeRef, unresolvedRegions);

  // Browser tab title: "<review name (truncated)> - <repo> - r3". App.tsx resets
  // it to "r3" when no review is open. A leading "• " mirrors the in-app "watching"
  // indicator so a backgrounded tab shows at a glance that an agent is watching
  // (and waiting on) this review. A small bullet, not U+25CF — the black circle
  // renders oversized in the tab strip.
  useEffect(() => {
    if (!detail) return;
    const name = detail.title || sourceLabel(detail, { ref: true });
    const short = name.length > 60 ? `${name.slice(0, 59)}…` : name;
    const base = [short, detail.repoName, "r3"].filter(Boolean).join(" - ");
    document.title = watching ? `• ${base}` : base;
  }, [detail, watching]);

  // Clicking a feedback card's file:line jumps the file pane to that line and
  // highlights it. Bumping the nonce re-scrolls even if it's already active.
  const locateFeedback = useCallback(
    (fb: FeedbackWithReplies | null) => {
      // null clears the active feedback (focus nothing) — e.g. after resolving the
      // last open item, with no next card to advance to.
      if (!fb) {
        setActiveFbId(null);
        return;
      }
      closeSheetForJump();
      // Anchored to a specific round → select its tab first so that round's DOM is
      // mounted before the highlight effect (keyed on scrollNonce) queries + scrolls
      // to it; both state updates batch into one render, effects run after commit.
      if (fb.patch_seq != null) setActiveRoundSeq(fb.patch_seq);
      // A folded target file has no mounted rows to scroll to — open it first (the
      // highlight effect's retry then catches the row once it mounts). Summary
      // feedback points at prose, not a file, so there's nothing to unfold.
      if (fb.file && fb.file !== SUMMARY_FILE) ensureFileOpen(fb.file);
      setActiveFbId(fb.id);
      setScrollNonce((n) => n + 1);
    },
    [ensureFileOpen, closeSheetForJump],
  );

  // The inverse of the above: click a highlighted region in the file pane to jump
  // the feedback panel to its feedback (regions carry data-fb-id, set by
  // useRegionHighlight). A *plain* click only — a drag that leaves a selection is
  // the "leave feedback" gesture; gutter clicks pick lines; links keep working.
  // A plain click that misses every region clears the active feedback, so clicking
  // blank file space unfocuses whichever card is currently highlighted.
  useEffect(() => {
    const root = scopeRef.current;
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target || target.closest("[data-gutter]") || target.closest("a")) return;
      const holder = target.closest("[data-fb-id]");
      const fallbackId = holder?.getAttribute("data-fb-id") ?? null;
      // A markdown block's one data-fb-id covers every feedback in it; resolve to
      // the one whose quote is actually under the cursor (no-op for code rows).
      const id = holder
        ? refineMarkdownClick(holder, e.clientX, e.clientY, unresolvedRegions, fallbackId)
        : null;
      const fb = id ? detail?.feedback.find((f) => f.id === id) : null;
      if (fb) locateFeedback(fb);
      else setActiveFbId(null);
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [detail, locateFeedback, unresolvedRegions]);

  // The list of files shown in the center, for the file browser + scroll-spy.
  // For a diff review only the active round renders, so the browser lists that
  // round's files (a path recurring across rounds isn't a concern here).
  const filesSrc = detail && "files" in detail.source ? detail.source : null;
  // Also the round behind the RoundSummary mounts — ReviewView owns that
  // placement (desktop: top of the scroll pane; mobile: the toolbar's middle
  // row). Undefined until the rounds load, so the summary appears with the diff.
  const activeRound = isDiff ? rounds.find((r) => r.seq === effectiveRoundSeq) : null;
  // The files a plain (non-diff) view browses: the live membership at `to=Current`,
  // else the chosen snapshot's captured file set.
  const browseFiles: string[] =
    toSnap === "WORKING"
      ? (filesSrc?.files ?? [])
      : (snapshots.find((s) => s.seq === toSnap)?.files ?? []);
  // The files shown in the center, for the file browser + scroll-spy, per mode: a
  // diff review's active round, the snapshot-diff's changed files, or the plain
  // view's browse set.
  const fileList: string[] = isDiff
    ? (activeRound?.files.map((f) => f.path) ?? [])
    : diffMode
      ? (snapDiff?.files.map((f) => f.path) ?? [])
      : browseFiles;

  // Viewed paths for the file-tree, resolved through the same content-identity
  // keys the cards use: a diff review keys on the active
  // round; the live files view keys on each file's reported sha. Snapshot-diff and
  // pinned-snapshot views don't track viewed, so the tree shows none there either.
  const liveFilesView = !isDiff && !diffMode && toSnap === "WORKING";
  const viewedPaths = useMemo(() => {
    const s = new Set<string>();
    if (isDiff && effectiveRoundSeq != null) {
      for (const p of fileList) if (isViewed(diffViewedKey(effectiveRoundSeq, p))) s.add(p);
    } else if (liveFilesView) {
      for (const p of fileList) {
        const sha = shas.get(p);
        if (sha && isViewed(fileViewedKey(p, sha))) s.add(p);
      }
    }
    return s;
  }, [isDiff, effectiveRoundSeq, liveFilesView, fileList, shas, isViewed]);

  // In-flight toolbar scroll animation: the rAF handle (to cancel when a new
  // jump starts) and a flag the scroll-spy checks so mid-flight frames don't
  // overwrite the activePath the jump just set (rapid next/next must step from
  // the *target*, not from wherever the animation happens to be).
  const scrollAnim = useRef(0);
  const scrollAnimating = useRef(false);

  const scrollToFile = useCallback((path: string, opts?: { animate?: boolean }) => {
    const root = scopeRef.current;
    if (!root) return;
    const el = root.querySelector(`[data-file="${CSS.escape(path)}"]`);
    if (!el) return;
    cancelAnimationFrame(scrollAnim.current);
    scrollAnimating.current = false;
    if (opts?.animate) {
      // Toolbar next/prev: a short fixed-duration ease-out — smooth, but it
      // reaches the destination in ~200ms no matter how far. (Native
      // behavior:"smooth" is distance-scaled: it crawls through dozens of
      // Shiki-highlighted blocks.) The destination is re-measured every frame,
      // so it stays exact while the target block is still unfolding under it.
      const from = root.scrollTop;
      const start = performance.now();
      scrollAnimating.current = true;
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / 200);
        const eased = 1 - (1 - t) ** 3;
        const dest =
          root.scrollTop + el.getBoundingClientRect().top - root.getBoundingClientRect().top;
        root.scrollTop = from + (dest - from) * eased;
        if (t < 1) scrollAnim.current = requestAnimationFrame(step);
        else scrollAnimating.current = false;
      };
      scrollAnim.current = requestAnimationFrame(step);
    } else {
      // File-browser click: instant jump — an animation through an arbitrary
      // distance of highlighted code reads as lag. Set scrollTop directly
      // (block:"start" of the target relative to the scroll container).
      root.scrollTop += el.getBoundingClientRect().top - root.getBoundingClientRect().top;
    }
    setActivePath(path);
  }, []);

  // Picking a file from the browser tree or the jump-to-file picker: unfold it,
  // then scroll to it. Clicking a file in the list is a "show me this" gesture,
  // so a viewed (auto-folded) file you click is one you want to read again —
  // open it rather than leaving it collapsed under its header.
  const selectFile = useCallback(
    (path: string) => {
      ensureFileOpen(path);
      scrollToFile(path);
    },
    [ensureFileOpen, scrollToFile],
  );

  // Toolbar: fold/unfold-all broadcast — a fresh nonce each click so repeating
  // the same action still overrides folds the user toggled by hand in between.
  const foldAll = useCallback((mode: "fold" | "unfold") => {
    setFoldSignal((s) => ({ mode, nonce: (s?.nonce ?? 0) + 1 }));
  }, []);

  // Toolbar: step to the adjacent file block, anchored on the scroll-spy's
  // current file so it follows wherever the user has scrolled to. The target
  // unfolds as we travel to it (path-scoped signal), and the ride is animated.
  const jumpFile = useCallback(
    (dir: 1 | -1) => {
      if (fileList.length === 0) return;
      const idx = activePath ? fileList.indexOf(activePath) : -1;
      const next =
        idx === -1
          ? dir === 1
            ? 0
            : fileList.length - 1
          : Math.min(fileList.length - 1, Math.max(0, idx + dir));
      const target = fileList[next];
      ensureFileOpen(target);
      scrollToFile(target, { animate: true });
    },
    [fileList, activePath, scrollToFile, ensureFileOpen],
  );

  // Scroll-spy: mark the file whose block currently sits at the top of the pane.
  // The listener reads the DOM live, so it stays correct as blocks load/render
  // without re-subscribing. Keyed on `detail` (not []) because the first commit
  // early-returns "Loading review…" — scopeRef is null there, and a one-shot
  // effect would never attach on a cold load.
  // biome-ignore lint/correctness/useExhaustiveDependencies: detail is the re-attach trigger; the listener reads the DOM, not the object
  useEffect(() => {
    const root = scopeRef.current;
    if (!root) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      // A toolbar jump owns activePath while its animation flies — mid-flight
      // frames must not re-spy it back to a block the ride is passing through.
      if (scrollAnimating.current) return;
      const top = root.getBoundingClientRect().top;
      const blocks = root.querySelectorAll("[data-file]");
      let current: string | null = blocks[0]?.getAttribute("data-file") ?? null;
      for (const b of blocks) {
        if (b.getBoundingClientRect().top - top <= 8) current = b.getAttribute("data-file");
        else break;
      }
      setActivePath(current);
    };
    // rAF-throttle: a wheel/trackpad flick fires many scroll events per frame, but
    // the spy only needs to run once per painted frame. Coalesce them so a fast
    // scroll doesn't repeat the querySelectorAll + getBoundingClientRect sweep
    // dozens of times between frames.
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    measure();
    return () => {
      root.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [detail]);

  // A floating "Quote in note" bubble raised over the file pane when a selection
  // or line-pick is made while the anchored composer already holds text (see
  // applyAnchorGesture). Fixed-positioned off the selection / first-row rect.
  const [fileQuote, setFileQuote] = useState<QuotePos | null>(null);

  // The one anchor gesture — a text selection OR a gutter line-pick, routed the
  // same way, optimized for the common case:
  //   • no anchored composer open       → open one on the selection
  //   • composer open, note still empty → re-anchor it to the selection
  //   • composer open, note has text    → never clobber the note; raise the
  //     "Quote in note" bubble so the selected code drops in as a `>` blockquote.
  // This kills the old footgun where selecting code to copy silently repointed a
  // half-written note. `rect` positions the bubble.
  const applyAnchorGesture = useCallback(
    (anchor: PendingAnchor, quoteText: string, rect: { left: number; top: number } | null) => {
      const d = getDraft(reviewId);
      const composing = d?.anchor != null && (d.text ?? "").trim() !== "";
      if (composing) {
        if (rect && quoteText.trim())
          setFileQuote({ left: rect.left, top: rect.top, text: quoteText });
        return; // a note is in progress — leave its anchor alone
      }
      setFileQuote(null);
      setDraftAnchor(reviewId, anchor);
      peekSheetForCompose();
    },
    [reviewId, peekSheetForCompose],
  );

  const onPickLines = useCallback(
    (
      file: string,
      side: DiffSide,
      lineStart: number,
      lineEnd: number,
      quote: string,
      patchSeq?: number,
    ) => {
      const anchor = { file, side, lineStart, lineEnd, quote, patchSeq };
      // Where a quote bubble would sit: centered over the first picked row.
      const root = scopeRef.current;
      const scope = patchSeq != null ? `[data-round="${patchSeq}"] ` : "";
      const base = `${scope}[data-file="${CSS.escape(file)}"]`;
      const rowEl =
        root?.querySelector(`${base} [data-line="${lineStart}"][data-side="${side}"]`) ??
        root?.querySelector(`${base} [data-line="${lineStart}"]`);
      const r = rowEl?.getBoundingClientRect();
      const rect = r ? { left: r.left + Math.min(r.width, 320) / 2, top: r.top } : null;
      applyAnchorGesture(anchor, quote, rect);
    },
    [applyAnchorGesture],
  );

  // The file header's feedback button: open the composer anchored to the whole
  // file (no line span, no quote — the file itself is the anchor). `patchSeq`
  // names the diff round the button lives in; the server drops it to null when it
  // doesn't name a stored round (files reviews, snapshot-diff view).
  const onFileFeedback = useCallback(
    (file: string, patchSeq?: number) => {
      setDraftAnchor(reviewId, {
        file,
        side: null,
        lineStart: null,
        lineEnd: null,
        quote: null,
        patchSeq,
      });
      peekSheetForCompose();
    },
    [reviewId, peekSheetForCompose],
  );

  // Jump to a reply pin ("addressed in diff N"): scroll the pinned row into
  // view, preferring the new side — pins point at the fix, not the old code.
  const locatePin = useCallback(
    (patchSeq: number, file: string | null, line: number | null) => {
      closeSheetForJump();
      // The pin usually names a different round than the one on screen — select
      // its tab, and open the pinned file if it's folded, then scroll to the
      // row (retryScrollToRow waits out the round tab + unfold mounting).
      setActiveRoundSeq(patchSeq);
      if (file) ensureFileOpen(file);
      const roundSel = `[data-round="${patchSeq}"]`;
      retryScrollToRow({
        getRoot: () => scopeRef.current,
        scrollToLine: virt.scrollToLine,
        scrollKey: file != null && line != null ? fileScrollKey(patchSeq, file) : null,
        containerSel: file ? `${roundSel} [data-file="${CSS.escape(file)}"]` : roundSel,
        line,
        side: "new",
      });
    },
    [virt.scrollToLine, ensureFileOpen, closeSheetForJump],
  );

  // Jump the pane to an `@path:Lx-y` ref clicked inside a rendered message,
  // resolved against the message's pinned `version` (a reply's ref_version, or a
  // feedback body's round). A diff review reuses the immutable round pin jump; a
  // files review whose ref names a content snapshot switches the pane to a plain
  // view of that snapshot first (its line numbers are what the ref was written
  // against), else scrolls the live file.
  const jumpToRef = useCallback(
    (ref: MessageRef, version: number | null) => {
      closeSheetForJump();
      if (isDiff) {
        locatePin(version ?? effectiveRoundSeq ?? 0, ref.file, ref.lineStart);
        return;
      }
      // A snapshot-pinned ref: show that snapshot plainly so the line lands right —
      // but only if we're not already viewing it. "Current" (WORKING) continues the
      // newest capture, so a ref pinned to the latest snapshot is already on screen
      // while we're on Current; switching to `v<latest>` there would needlessly yank
      // the pane off the live view for no visible change.
      if (version != null && snapshots.some((s) => s.seq === version)) {
        const latestSeq = Math.max(...snapshots.map((s) => s.seq));
        const alreadyShown =
          fromSnap === null &&
          (toSnap === version || (toSnap === "WORKING" && version === latestSeq));
        if (!alreadyShown) {
          setFromSnap(null);
          setToSnap(version);
        }
      }
      ensureFileOpen(ref.file);
      retryScrollToRow({
        getRoot: () => scopeRef.current,
        scrollToLine: virt.scrollToLine,
        scrollKey: fileScrollKey(null, ref.file),
        containerSel: `[data-file="${CSS.escape(ref.file)}"]`,
        line: ref.lineStart,
        side: null,
      });
    },
    [
      isDiff,
      locatePin,
      effectiveRoundSeq,
      snapshots,
      fromSnap,
      toSnap,
      ensureFileOpen,
      virt.scrollToLine,
      closeSheetForJump,
    ],
  );

  // "Quote in note": drop the file-pane selection into the anchored note as a `>`
  // blockquote, then focus the composer. It lives in the feedback panel (out of
  // this subtree), so it's reached by its data attr rather than a ref.
  const quoteIntoNote = useCallback(
    (text: string) => {
      const cur = getDraft(reviewId)?.text ?? "";
      setDraftText(reviewId, quoteBlock(cur, text).text);
      setFileQuote(null);
      window.getSelection()?.removeAllRanges();
      focusComposer();
    },
    [reviewId],
  );

  // Dismiss the file-pane quote bubble once its fixed position would go stale (the
  // pane scrolled) or the selection collapsed.
  useEffect(() => {
    if (!fileQuote) return;
    const root = scopeRef.current;
    const onScroll = () => setFileQuote(null);
    const onSel = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed) setFileQuote(null);
    };
    root?.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("selectionchange", onSel);
    return () => {
      root?.removeEventListener("scroll", onScroll);
      document.removeEventListener("selectionchange", onSel);
    };
  }, [fileQuote]);

  // Anchor a draft to whatever text is selected in the file view. Listen at the
  // document level, not on the scroll pane: a selection drag can end anywhere —
  // notably over the feedback panel — where the pane's own mouseup never fires,
  // which is why re-selecting near the panel edge used to leave the pending
  // draft stuck on the old region. getSelectionAnchor returns null unless the
  // selection actually lands on a file line, so clicks and panel-internal
  // selections are ignored. Coarse pointers never fire a usable mouseup for a
  // long-press selection — the AddFeedbackPill (mounted below) drives them off
  // selectionchange instead — so skip this listener there.
  useEffect(() => {
    if (coarse) return;
    const onMouseUp = () => {
      const root = scopeRef.current;
      if (!root) return;
      const a = getSelectionAnchor(root);
      if (!a) return;
      const sel = window.getSelection();
      const text = sel?.toString() ?? "";
      let rect: { left: number; top: number } | null = null;
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        rect = { left: r.left + r.width / 2, top: r.top };
      }
      applyAnchorGesture(a, text, rect);
    };
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
  }, [applyAnchorGesture, coarse]);

  // Drop just the anchored composer (its anchor + note), leaving any general note
  // or drafted reply on the review untouched. Both the deliberate Cancel/✕ discard
  // and a committed add settle the mobile sheet and clear the anchor the same way —
  // Cancel needs no confirm (Esc already preserves a non-empty note by only
  // blurring). Stable so the memoized FeedbackPanel isn't re-rendered on every
  // scroll-spy activePath change.
  const discardPending = useCallback(() => {
    settleSheetAfterCompose();
    dropAnchor(reviewId);
  }, [reviewId, settleSheetAfterCompose]);

  // Leaving the review (remount on switch) drops a text-less anchor so an empty
  // composer doesn't linger/reopen; a draft with text (of any kind) stays persisted.
  useEffect(() => {
    return () => {
      const d = getDraft(reviewId);
      if (d && d.text.trim() === "") dropAnchor(reviewId);
    };
  }, [reviewId]);

  // The review-level edits (approve/abandon/reopen, rename) are lower-frequency
  // than the per-card ones but share the shape: patch the cached ReviewDetail in
  // onMutate so the status pill / title change instantly, and roll back on error.
  // Like the card mutations there is no onSettled refetch — the PATCH broadcasts a
  // review-updated event this tab receives too, and useServerEvents reconciles off
  // it. Cancel refetches in flight at click time so they can't land over the
  // optimistic patch. (`remove` below navigates away on success, so there's
  // nothing to keep optimistic.)
  const reviewKey = ["review", reviewId] as const;
  const beginReviewPatch = async () => {
    await qc.cancelQueries({ queryKey: reviewKey });
    return qc.getQueryData<ReviewDetail>(reviewKey);
  };
  const restoreReview = (prev: ReviewDetail | undefined) => {
    if (prev) qc.setQueryData(reviewKey, prev);
    // A failed PATCH has no SSE echo and the snapshot may predate concurrent
    // writes whose echo refetch beginReviewPatch cancelled — refetch server truth
    // after the rollback (after: the manual set above marks the query fresh).
    qc.invalidateQueries({ queryKey: reviewKey });
  };
  // Every review-level edit (approve/abandon/reopen, rename) goes through one PATCH:
  // optimistically patch whichever visible field the body carries (status, title) so
  // the pill/title changes instantly; an invisible one (note→meta.next_steps)
  // reconciles via the review-updated echo the server broadcasts to every tab + the
  // reviews list. (The summary is CLI-only — `r3 edit --summary` — so it's never PATCHed
  // here.)
  const updateReview = useMutation({
    onMutate: async (body: UpdateReviewBody) => {
      const prev = await beginReviewPatch();
      if (body.status !== undefined)
        qc.setQueryData<ReviewDetail>(reviewKey, (d) =>
          d ? { ...d, status: body.status ?? d.status } : d,
        );
      if (body.title !== undefined)
        qc.setQueryData<ReviewDetail>(reviewKey, (d) =>
          d ? { ...d, title: body.title ?? null } : d,
        );
      return { prev };
    },
    mutationFn: (body: UpdateReviewBody) => api.patchReview(reviewId, body),
    onError: (_e, _v, ctx) => restoreReview(ctx?.prev),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteReview(reviewId),
    onSuccess: () => {
      clearDraft(reviewId); // no orphaned draft for a deleted review
      qc.invalidateQueries({ queryKey: ["reviews"] });
      navigate("/");
    },
  });

  // Replace the view with an error when there's no data at all (a first-load
  // failure from a stale URL) OR when the open review was deleted out from under
  // us — a 404 on refetch, even though TanStack still holds the last-good detail.
  // A transient refetch error over a loaded review is otherwise ignored (the
  // stale view beats a flicker).
  const gone = error instanceof ApiError && error.status === 404;
  if ((error && !detail) || gone)
    return (
      <div className="flex h-full flex-col items-start gap-3 p-6">
        <p className="text-sm text-danger-500">{(error as Error).message}</p>
        <Button onClick={() => navigate("/")}>← Back to reviews</Button>
      </div>
    );
  if (isLoading || !detail)
    return <div className="p-6 text-sm text-neutral-400">Loading review…</div>;

  // The review header (status/title/meta + the Approve/Abandon actions).
  // Desktop pins it above the split; mobile mounts it INSIDE the scroll pane
  // (see below) so it scrolls away with the rest of the header stack.
  const reviewHeader = (
    <ReviewHeader
      detail={detail}
      onSaveTitle={(title) => updateReview.mutate({ title })}
      onSetStatus={(s) => updateReview.mutate({ status: s })}
      onApprove={(note) => updateReview.mutate({ status: "approved", note: note || null })}
      onDelete={() => {
        if (confirm("Delete this review and all its feedback?")) remove.mutate();
      }}
    />
  );

  // The review summary + pane toolbar. Desktop docks them above the scroll pane
  // (pinned, so they never compete with the file headers' own sticky top-0); on
  // mobile they mount — together with the header above — INSIDE the pane, at the
  // top of the scrollable content. That gives the phone a whole-page-scroll
  // feel: scrolling down slides the header stack (title, review summary, round
  // selector, diff summary, toolbar) off screen, the sticky file headers take
  // over at the pane top, and the code gets the full height between the navbar
  // and the bottom bar.
  //
  // ReviewSummary refs pin no version (the summary is edited in place), so they
  // resolve against the live/current view: null → the round on screen for a
  // diff review, the live file for a files review.
  const reviewSummaryEl = (
    <ReviewSummary
      summary={detail.summary}
      onJumpRef={(ref) => jumpToRef(ref, null)}
      onAnchorSummary={applyAnchorGesture}
    />
  );
  // The active round's summary, built once and mounted per tier — desktop at
  // the top of the scrollable content, mobile as the toolbar's middle row — so
  // its props can't drift between the two mounts. A round-summary ref resolves
  // against its own round.
  const roundSummaryEl = activeRound ? (
    <RoundSummary
      round={activeRound}
      onAnchorSummary={applyAnchorGesture}
      onJumpRef={(ref, seq) => jumpToRef(ref, seq)}
    />
  ) : null;
  // A multi-round diff gets a round switcher so the file panel shows a single
  // round at a time; an empty round still shows the strip so the switcher stays
  // reachable.
  const paneToolbarEl =
    fileList.length > 0 || (isDiff && rounds.length > 1) || snapshots.length > 0 ? (
      <PaneToolbar
        hasFiles={fileList.length > 0}
        filePicker={
          <JumpToFile
            files={fileList}
            viewed={viewedPaths}
            activePath={activePath}
            onSelect={selectFile}
            btnClassName={TOOLBAR_BTN}
          />
        }
        onJump={jumpFile}
        onFoldAll={foldAll}
        summary={isMobile ? roundSummaryEl : undefined}
        right={
          isDiff && rounds.length > 1 ? (
            <RoundSelect
              rounds={rounds}
              activeSeq={effectiveRoundSeq}
              onSelect={setActiveRoundSeq}
            />
          ) : snapshots.length > 0 ? (
            <SnapshotSelect
              snapshots={snapshots}
              from={fromSnap}
              to={toSnap}
              onFromChange={setFromSnap}
              onToChange={setToSnap}
            />
          ) : undefined
        }
      />
    ) : null;
  // The one FeedbackPanel, mounted in the desktop side dock or the mobile
  // bottom sheet — built once so the two mounts can't drift apart.
  const feedbackPanel = (
    <FeedbackPanel
      detail={detail}
      pending={pending}
      onDiscardPending={discardPending}
      onSubmittedPending={discardPending}
      activeFeedbackId={activeFbId}
      scrollNonce={scrollNonce}
      onLocateFeedback={locateFeedback}
      onLocatePin={locatePin}
      onJumpRef={jumpToRef}
      coarse={coarse}
    />
  );

  return (
    <div className="flex h-full flex-col">
      {!isMobile && reviewHeader}
      {detail.stale && (
        <div className="shrink-0 border-b border-warning-300 bg-warning-50 px-4 py-2 text-xs text-warning-800 dark:border-warning-900/60 dark:bg-warning-950/40 dark:text-warning-300">
          ⚠ This review's worktree isn't available (moved, removed, or the repo path is missing).
          Showing last-known state — relink the project from the reviews list (the "Reviews" link)
          to restore live content.
        </div>
      )}
      {detail.scratchIgnoredDirs.length > 0 && (
        <div className="shrink-0 border-b border-warning-300 bg-warning-50 px-4 py-2 text-xs text-warning-800 dark:border-warning-900/60 dark:bg-warning-950/40 dark:text-warning-300">
          ⚠ Scratch reviews are flat —{" "}
          {detail.scratchIgnoredDirs.length === 1 ? "subdirectory" : "subdirectories"}{" "}
          <span className="font-mono">{detail.scratchIgnoredDirs.join(", ")}</span>{" "}
          {detail.scratchIgnoredDirs.length === 1 ? "is" : "are"} ignored (not shown or watched).
          Move files to the top level of the scratch directory.
        </div>
      )}
      <div ref={splitRef} className="flex min-h-0 flex-1">
        {!isMobile && fileList.length > 0 && (
          <FileBrowser
            files={fileList}
            viewed={viewedPaths}
            activePath={activePath}
            onSelect={selectFile}
          />
        )}
        {/* Content column: a diff review with more than one round gets a round
            switcher above the scroll pane so the file panel shows a single round
            at a time (the pane stays scrollable under it). */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* Desktop: the review summary docks at the top of the file-viewer
              column rather than full-width above the split (its prose is
              width-capped, so the extra width the full span bought was wasted
              whitespace on the right), and the toolbar is pinned above the
              scroll pane. Mobile mounts both inside the pane instead — see the
              header-stack comment above. */}
          {!isMobile && reviewSummaryEl}
          {!isMobile && paneToolbarEl}
          {/* shiki-surface paints the pane in the syntax theme's own editor
              background, so the full-bleed file blocks read as one continuous
              full-height surface (no card insets, nothing peeking around them). */}
          <div
            ref={scopeRef}
            className="shiki-surface min-w-0 flex-1 overflow-y-auto"
            style={
              stickyToolbarH > 0
                ? ({ ...surfaceVars, "--pane-sticky-h": `${stickyToolbarH}px` } as CSSProperties)
                : surfaceVars
            }
          >
            <VirtualPaneProvider scrollRef={scopeRef} registry={virt.registry}>
              {/* Mobile: the header + summary scroll away with the code, but the
                  toolbar (switcher · round summary · buttons) sticks at the pane
                  top — the sticky header stack is toolbar + file header. */}
              {isMobile && (
                <>
                  {reviewHeader}
                  {reviewSummaryEl}
                  {paneToolbarEl && (
                    <StickyToolbar onHeight={setStickyToolbarH}>{paneToolbarEl}</StickyToolbar>
                  )}
                </>
              )}
              {/* Desktop keeps the round summary at the top of the scrollable
                  content, above the file blocks (mobile mounts it in the toolbar
                  instead — the `summary` slot above). */}
              {!isMobile && roundSummaryEl}
              {isDiff && diff && (
                <DiffView
                  rounds={rounds}
                  activeSeq={effectiveRoundSeq}
                  isViewed={isViewed}
                  toggle={toggleViewed}
                  onPickLines={onPickLines}
                  onFileFeedback={onFileFeedback}
                  foldSignal={foldSignal}
                />
              )}
              {isDiff && !diff && (
                <p
                  className={cn("p-6 text-sm", diffError ? "text-danger-500" : "text-neutral-400")}
                >
                  {diffError ? (diffError as Error).message : "Loading diff…"}
                </p>
              )}

              {/* Files review, diff mode: the derived snapshot→snapshot (or
                snapshot→live) diff, rendered through DiffView as one synthetic
                round. Feedback is placed onto it by quote. */}
              {!isDiff &&
                diffMode &&
                (snapDiff ? (
                  <DiffView
                    rounds={snapRounds}
                    activeSeq={SNAPSHOT_DIFF_SEQ}
                    // No viewed tracking in a files review's derived diff;
                    // omitting isViewed/toggle hides the toggle.
                    onPickLines={onPickLines}
                    onFileFeedback={onFileFeedback}
                    foldSignal={foldSignal}
                  />
                ) : (
                  <p className="p-6 text-sm text-neutral-400">Loading diff…</p>
                ))}

              {/* Files review, plain view: the live files (to=Current) or a chosen
                snapshot's captured content (to=snapshot N). */}
              {!isDiff &&
                !diffMode &&
                filesSrc &&
                filesSrc.files.length === 0 &&
                toSnap === "WORKING" &&
                detail.scratchDir && (
                  <div className="p-8 text-center text-sm text-neutral-400">
                    <p className="font-medium text-neutral-500 dark:text-neutral-400">
                      No files yet
                    </p>
                    <p className="mt-1">
                      Drop files into this scratch directory — they appear here live:
                    </p>
                    <code className="mt-2 inline-block rounded bg-neutral-100 px-2 py-1 font-mono text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                      {detail.scratchDir}
                    </code>
                  </div>
                )}
              {!isDiff &&
                !diffMode &&
                filesSrc &&
                browseFiles.map((f) => (
                  <FileView
                    key={f}
                    path={f}
                    refName={filesSrc.ref}
                    reviewId={reviewId}
                    snapshotSeq={toSnap === "WORKING" ? undefined : toSnap}
                    // Viewed only in the live view: a
                    // parent-computed per-file boolean (keyed through the reported
                    // sha in viewedPaths) plus the stable toggle. A pinned snapshot
                    // browse omits the toggle, hiding it.
                    viewed={liveFilesView ? viewedPaths.has(f) : false}
                    toggle={liveFilesView ? toggleViewed : undefined}
                    onSha={liveFilesView ? onSha : undefined}
                    onPickLines={onPickLines}
                    onFileFeedback={onFileFeedback}
                    foldSignal={foldSignal}
                  />
                ))}
            </VirtualPaneProvider>
          </div>
        </div>

        {!isMobile && (
          <div
            className="relative shrink-0 border-l-2 border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900"
            style={{ width: feedbackWidth }}
          >
            {/* Drag handle straddling the left border; grabs a 8px strip and
                widens the panel as you pull it left. Double-click resets the split. */}
            <div
              onPointerDown={onFeedbackResize}
              onDoubleClick={onFeedbackResetSplit}
              title="Drag to resize · double-click to reset"
              className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize transition-colors hover:bg-primary-400/40"
            />
            {feedbackPanel}
          </div>
        )}
      </div>
      {isMobile && (
        <MobileReviewChrome
          openCount={detail.feedback.filter((f) => f.status !== "resolved").length}
          sheet={sheet}
          onSetSheet={setSheet}
        >
          {feedbackPanel}
        </MobileReviewChrome>
      )}
      {/* "Quote in note" bubble for a file-pane selection made while the anchored
          composer already holds text — fixed-positioned, so it lives at the root. */}
      {fileQuote && <QuoteBubble pos={fileQuote} label="Quote in note" onQuote={quoteIntoNote} />}
      {/* Touch-tier selection anchoring: the pill floats over a code selection and
          routes the tap through the same applyAnchorGesture the mouseup path uses.
          Coarse-pointer only (it replaces that mouseup path), on either layout tier.
          While composing the pill IS the quote affordance — it quotes directly in
          one tap rather than routing through applyAnchorGesture, whose composing
          branch would only summon the desktop bubble for a second tap. Label and
          action read the same `composing`, so they can't disagree. */}
      {coarse && (
        <AddFeedbackPill
          scopeRef={scopeRef}
          composing={composing}
          onAdd={(anchor, quote) => {
            // No rect: applyAnchorGesture only reads it in its composing branch
            // (to place the desktop QuoteBubble), which the pill never reaches —
            // composing routes to quoteIntoNote below instead.
            if (!composing) return applyAnchorGesture(anchor, quote, null);
            // The sheet may have been dismissed since typing began — raise the
            // peek so the note the quote just landed in is on screen.
            if (isMobile) setSheet((s) => (s === "closed" ? "peek" : s));
            quoteIntoNote(quote);
          }}
        />
      )}
    </div>
  );
}
