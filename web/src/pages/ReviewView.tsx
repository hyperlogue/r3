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
import { DiffView, type FetchContext, RoundSelect, RoundSummary } from "../components/DiffView.tsx";
import { FeedbackPanel, RAIL_WIDTH } from "../components/FeedbackPanel.tsx";
import { FileBrowser } from "../components/FileBrowser.tsx";
import type { FoldSignal } from "../components/FileCard.tsx";
import { FileView } from "../components/FileView.tsx";
import { JumpToFile } from "../components/JumpToFile.tsx";
import { QuoteBubble, type QuotePos, quoteBlock } from "../components/Message.tsx";
import { DiffLayoutToggle, PaneToolbar, TOOLBAR_BTN } from "../components/PaneToolbar.tsx";
import { ReviewHeader } from "../components/ReviewHeader.tsx";
import { ReviewSummary } from "../components/ReviewSummary.tsx";
import { ShortcutsOverlay } from "../components/ShortcutsOverlay.tsx";
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
import { useKeyBindings } from "../keys.ts";
// The one sanctioned mobile-module import: ReviewView is the single mount point.
import { AddFeedbackPill } from "../mobile/AddFeedbackPill.tsx";
import { MobileReviewChrome, type MobileSheetState } from "../mobile/MobileReviewChrome.tsx";
import { useIsMobile } from "../mobile/useIsMobile.ts";
import { usePointerCoarse } from "../mobile/usePointerCoarse.ts";
import { focusComposer, usePaneCrossfade } from "../pane.ts";
import {
  PROGRESSIVE_FILES_MIN,
  ProgressiveFile,
  ProgressiveFileProvider,
  useProgressiveFileController,
} from "../progressive.tsx";
import { type Placement, placeInDiff } from "../resolveFeedback.ts";
import { navigate } from "../router.ts";
import { type AnchorRect, getSelectionAnchor, type PendingAnchor } from "../selection.ts";
import {
  getFeedbackCollapsed,
  setDiffLayout,
  setFeedbackCollapsed,
  useDiffLayout,
  useFeedbackCollapsed,
  useSyntaxTheme,
} from "../settings.ts";
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
import { useOptimisticPatch } from "../useOptimistic.ts";
import { usePaneJumps } from "../usePaneJumps.ts";
import { diffViewedKey, fileViewedKey, useViewedFiles } from "../viewed.ts";
import { useVirtualPaneController, VirtualPaneProvider } from "../virtual.tsx";

// Synthetic [data-round] seq for a files-review snapshot-diff. Never sent to the
// server (files-review feedback has patch_seq null).
const SNAPSHOT_DIFF_SEQ = 0;

// Scroll-spy hands "current file" to the next block once the one above is down
// to this share of pane height. Wholly-visible blocks are exempt.
const ACTIVE_HANDOFF_SHARE = 0.15;

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
  // The sibling review-level registry wakes a deferred file body before a
  // picker/feedback/ref jump asks the existing row retry machinery to find it.
  const progressive = useProgressiveFileController();
  // Fold/unfold broadcast to the file cards: the toolbar's fold-all, and the
  // path-scoped unfolds that a next/prev jump or a feedback-locate fires so a
  // folded target file opens (mounting its rows) before we scroll to its line.
  // A fresh nonce each time so repeating an action overrides hand-toggled folds.
  const [foldSignal, setFoldSignal] = useState<FoldSignal | null>(null);
  // Last unscoped fold-all / unfold-all, so a FileCard that hydrates later
  // (never saw the nonce) still opens in that mode.
  const [unscopedFold, setUnscopedFold] = useState<"fold" | "unfold" | null>(null);
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
  // Desktop: the dock folds to a narrow rail so the content pane gets the width
  // (a persisted global display preference, like the diff layout). Below md there
  // is no rail — the bottom sheet's closed state already is "collapsed" — so the
  // preference is ignored there WITHOUT being written, and a collapse-preferring
  // user gets the rail back the moment the viewport is wide again.
  const collapsePref = useFeedbackCollapsed();
  // Phone tier: the side dock and sidebar don't mount; the same FeedbackPanel
  // renders inside the MobileReviewChrome sheet instead (closed / composer-peek
  // / full). All mobile deltas live at this mount-point fork + the sheet-state
  // nudges below — never inside the panel or the domain state.
  const isMobile = useIsMobile();
  const [sheet, setSheet] = useState<MobileSheetState>("closed");
  // Touch anchoring keys on the *pointer*, not the width tier (see usePointerCoarse
  // / the mobile-tier skill): a coarse pointer swaps the desktop mouseup selection path
  // for the AddFeedbackPill, on either layout tier. `composing` mirrors
  // applyAnchorGesture's own branch so the pill's label tells the truth — an empty
  // composer anchors a note, a composer already holding text quotes the selection in.
  const coarse = usePointerCoarse();
  const hasAnchoredText = useHasAnchoredText(reviewId);
  const composing = pending != null && hasAnchoredText;
  const panelCollapsed = !isMobile && collapsePref;
  // Where the gesture that opened the composer happened, in viewport pixels. Only
  // the collapsed panel reads it (it floats the composer there instead of docking
  // it at the bottom of a list that isn't on screen), but it's measured on every
  // gesture regardless: collapsing mid-compose must not leave the composer with
  // nowhere to go. Cleared with the anchor.
  const [composerAt, setComposerAt] = useState<AnchorRect | null>(null);

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
  // Round chrome (switcher, latest, prev/next) reads PatchMeta from detail —
  // already on the review payload, no highlight cost. Seq 0 is the legacy
  // live-render round when a diff review never stored patches.
  const patchMetas = detail?.patches ?? [];
  const effectiveRoundSeq =
    activeRoundSeq != null && patchMetas.some((r) => r.seq === activeRoundSeq)
      ? activeRoundSeq
      : (patchMetas[patchMetas.length - 1]?.seq ?? (isDiff ? 0 : null));
  // One highlighted round — the seq on screen. hooks.ts still prefix-invalidates
  // ["review-diff", reviewId], which covers every seq.
  const { data: diff, error: diffError } = useQuery({
    queryKey: ["review-diff", reviewId, effectiveRoundSeq, syntaxTheme],
    queryFn: () => api.reviewDiff(reviewId, syntaxTheme, effectiveRoundSeq ?? undefined),
    enabled: isDiff && effectiveRoundSeq != null,
  });
  const fetchedRound = diff?.rounds.find((r) => r.seq === effectiveRoundSeq) ?? null;

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
  // The phone tier forces unified — two code columns don't fit a phone pane, and
  // the mobile rule is isolate-don't-interleave. Deliberately overridden here, at
  // the one sanctioned mobile mount point, WITHOUT writing the preference: a
  // split-preferring reader gets split back the moment the viewport is wide again.
  const diffLayoutPref = useDiffLayout();
  const diffLayout = isMobile ? "unified" : diffLayoutPref;

  // Expand-context fetchers, one per rendered mode. Deliberately built
  // separately rather than switched on a round seq: a files review's derived
  // snapshot diff is presented as synthetic round 0, which would collide with
  // the legacy live-render round 0 of a diff review. A null result (the source
  // can't cover the range) leaves the gap exactly as it was.
  const fetchRoundContext = useCallback<FetchContext>(
    async (file, start, end) => {
      if (effectiveRoundSeq == null) return null;
      const r = await api
        .diffContext(reviewId, { seq: effectiveRoundSeq }, file, start, end, syntaxTheme)
        .catch(() => null);
      return r?.lines ?? null;
    },
    [reviewId, effectiveRoundSeq, syntaxTheme],
  );
  const fetchSnapContext = useCallback<FetchContext>(
    async (file, start, end) => {
      if (fromSnap == null) return null;
      const r = await api
        .diffContext(reviewId, { from: fromSnap, to: toSnap }, file, start, end, syntaxTheme)
        .catch(() => null);
      return r?.lines ?? null;
    },
    [reviewId, fromSnap, toSnap, syntaxTheme],
  );
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
  // snapshot, and a snapshot-diff). Null until detail exists so the initial load
  // doesn't count as a switch; a files selection always maps to a concrete key.
  const paneVersionKey = !detail
    ? null
    : isDiff
      ? `d:${effectiveRoundSeq}`
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
  // it to "r3" when no review is open. A leading "• " mirrors live agent presence,
  // so a backgrounded tab shows that an agent is watching or actively working on
  // this review. A small bullet, not U+25CF — the black circle renders oversized
  // in the tab strip.
  useEffect(() => {
    if (!detail) return;
    const name = detail.title || sourceLabel(detail, { ref: true });
    const short = name.length > 60 ? `${name.slice(0, 59)}…` : name;
    const base = [short, detail.repoName, "r3"].filter(Boolean).join(" - ");
    document.title = watching || detail.working ? `• ${base}` : base;
  }, [detail, watching]);

  // Focus a feedback without moving the content pane: light its card and re-ring
  // its anchor where it already is. Everything that merely shifts *which* note is
  // current — resolve/reply advancing down the list, `j`/`k`, clicking a
  // highlighted region — goes through this; only an explicit locate (the card's
  // file:line header, a reply's pin, `o`) jumps the pane, via locateFeedback's
  // scrollNonce bump.
  const focusFeedback = useCallback((fb: FeedbackWithReplies | null) => {
    setActiveFbId(fb?.id ?? null);
  }, []);

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
      // A markdown block's one data-fb-id covers the whole <p>/<ul>, far wider
      // than the marked quote; resolve to the feedback whose quote is actually
      // under the cursor, or to nothing (no-op for code rows).
      const id = holder
        ? refineMarkdownClick(holder, e.clientX, e.clientY, unresolvedRegions, fallbackId)
        : null;
      const fb = id ? detail?.feedback.find((f) => f.id === id) : null;
      // Focus, don't locate: the clicked region is already under the cursor, so
      // there is nothing to scroll to — only the feedback panel moves (its card
      // scrolls into view off the activeFeedbackId change).
      focusFeedback(fb ?? null);
      // …which needs a panel to move in. Clicking a washed region is asking to
      // READ that note, so it un-collapses the dock — the one gesture allowed to,
      // since the alternative is a click that visibly does nothing. Read
      // non-reactively so this listener doesn't re-attach on every toggle, and
      // only when it would actually change (the store writes unconditionally).
      if (fb && !isMobile && getFeedbackCollapsed()) setFeedbackCollapsed(false);
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [detail, focusFeedback, unresolvedRegions, isMobile]);

  // The list of files shown in the center, for the file browser + scroll-spy.
  // For a diff review only the active round renders, so the browser lists that
  // round's files (a path recurring across rounds isn't a concern here).
  const filesSrc = detail && "files" in detail.source ? detail.source : null;
  // Also the round behind the RoundSummary mounts — ReviewView owns that
  // placement (desktop: top of the scroll pane; mobile: the toolbar's middle
  // row). Meta comes from detail, so the summary doesn't wait on highlight.
  const activeRound = isDiff ? (patchMetas.find((r) => r.seq === effectiveRoundSeq) ?? null) : null;
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
    ? (fetchedRound?.files.map((f) => f.path) ?? [])
    : diffMode
      ? (snapDiff?.files.map((f) => f.path) ?? [])
      : browseFiles;
  // Large plain-file views progressively hydrate bodies. Diff rounds already
  // arrive as one bounded rendered payload and keep their existing path.
  const progressiveFiles = !isDiff && !diffMode && browseFiles.length >= PROGRESSIVE_FILES_MIN;
  const progressiveVersion = `${reviewId}:${toSnap}:${syntaxTheme}`;
  const hasFile = useCallback((path: string) => fileList.includes(path), [fileList]);
  const { locateFeedback, locatePin, jumpToRef, openDocLink, selectFile, scrollAnimating } =
    usePaneJumps({
      scopeRef,
      scrollToLine: virt.scrollToLine,
      progressive,
      setFoldSignal,
      closeSheetForJump,
      setActiveFbId,
      setScrollNonce,
      setActiveRoundSeq,
      setActivePath,
      isDiff,
      effectiveRoundSeq,
      snapshots,
      fromSnap,
      toSnap,
      setFromSnap,
      setToSnap,
      hasFile,
    });

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

  // Which way a *directionless* fold-all goes next — the `Z` key, which has one
  // key to the toolbar's two buttons. It lives here, next to foldAll, rather than
  // at the key site so the toolbar's own clicks update it too: after clicking
  // "Fold all", `Z` has to unfold, not fold an already-folded pane again. Starts
  // at "fold", the useful direction from a freshly-opened review. A ref, not
  // state — nothing renders from it.
  const foldAllDir = useRef<"fold" | "unfold">("fold");

  // Toolbar: fold/unfold-all broadcast — a fresh nonce each click so repeating
  // the same action still overrides folds the user toggled by hand in between.
  const foldAll = useCallback((mode: "fold" | "unfold") => {
    foldAllDir.current = mode === "fold" ? "unfold" : "fold";
    setUnscopedFold(mode);
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
      selectFile(target, { animate: true });
    },
    [fileList, activePath, selectFile],
  );

  // Toggle Viewed on one path (the `x` shortcut). The file headers build their own
  // content-identity key — a diff round's file from the round seq, a live file from
  // the sha only that card has loaded — so this rebuilds the same key from what the
  // view knows: `shas`, reported up by each FileView for exactly this reason.
  // Views that don't track viewed (a snapshot-diff, a pinned-snapshot browse) hide
  // the pill, and this no-ops for the same reason.
  const toggleViewedPath = useCallback(
    (path: string) => {
      if (isDiff && effectiveRoundSeq != null) toggleViewed(diffViewedKey(effectiveRoundSeq, path));
      else if (liveFilesView) {
        const sha = shas.get(path);
        if (sha) toggleViewed(fileViewedKey(path, sha));
      }
    },
    [isDiff, effectiveRoundSeq, liveFilesView, shas, toggleViewed],
  );

  // The round a whole-file note opens against, matching what each view passes to
  // its own header button: the active round in a diff review, the synthetic round
  // in a snapshot-diff, and nothing in a plain files view.
  const feedbackPatchSeq = isDiff
    ? (effectiveRoundSeq ?? undefined)
    : diffMode
      ? SNAPSHOT_DIFF_SEQ
      : undefined;

  // `<` / `>`: step the version on screen. For a diff review that's the round
  // strip; for a snapshotted files review it's the `to` bound of the from→to
  // range, over the same oldest→newest→Current order SnapshotSelect lists (so the
  // keys walk the dropdown top-to-bottom as drawn). Clamped at both ends — no
  // wrap: stepping past the newest round should stop, not silently restart at the
  // oldest. Stepping `to` can invert the range, so `from` snaps down with it,
  // exactly as picking that row in the dropdown would.
  const stepVersion = useCallback(
    (dir: 1 | -1) => {
      if (isDiff) {
        if (patchMetas.length === 0) return;
        const at = patchMetas.findIndex((r) => r.seq === effectiveRoundSeq);
        const next =
          patchMetas[Math.min(patchMetas.length - 1, Math.max(0, (at < 0 ? 0 : at) + dir))];
        if (next) setActiveRoundSeq(next.seq);
        return;
      }
      if (snapshots.length === 0) return;
      const order: SnapshotRef[] = [
        ...[...snapshots].sort((a, b) => a.seq - b.seq).map((s) => s.seq),
        "WORKING",
      ];
      const at = order.indexOf(toSnap);
      const pos = Math.min(order.length - 1, Math.max(0, (at < 0 ? order.length - 1 : at) + dir));
      if (pos === at) return;
      const fromPos = fromSnap == null ? -1 : order.indexOf(fromSnap);
      if (fromPos >= pos) {
        const below = order[pos - 1];
        setFromSnap(pos - 1 >= 0 && below !== "WORKING" ? below : null);
      }
      setToSnap(order[pos]);
    },
    [isDiff, patchMetas, effectiveRoundSeq, snapshots, toSnap, fromSnap],
  );

  // Scroll-spy: mark the file you're mostly looking at.
  //
  // The rule is "the first file block still showing in the pane — unless it's
  // nearly gone and something follows it." A crossed-scanline test (what this was)
  // only hands over once the NEXT file reaches the top, so the marker stayed on a
  // file reduced to a sliver while its successor filled the screen. Handing over
  // at ACTIVE_HANDOFF_SHARE means the marker moves while you're still scrolling
  // toward the next file, which is when you've already started reading it.
  //
  // The `clipped` half of the test is what keeps small blocks safe: a folded file
  // is one 2rem header and can NEVER occupy 15% of the pane, so a bare share test
  // would skip past every folded file — and `]`/`[` index on activePath, so
  // stepping onto one would immediately report the file after it. A block that is
  // wholly on screen is never handed off, whatever its size.
  //
  // The listener reads the DOM live, so it stays correct as blocks load/render
  // without re-subscribing. Keyed on `detail` (not []) because the first commit
  // early-returns "Loading review…" — scopeRef is null there, and a one-shot
  // effect would never attach on a cold load.
  //
  // ALSO keyed on the rendered file set: a version switch swaps the pane's blocks
  // without touching `detail` or firing a scroll. Per-file shortcuts MUTATE against
  // activePath, so a stale one writes a viewed mark no card reads / opens a
  // whole-file note the server rejects. Re-measure on the swap.
  const fileListKey = fileList.join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: detail + the rendered file set are the re-attach/re-measure triggers; the listener reads the DOM, not either object
  useEffect(() => {
    const root = scopeRef.current;
    if (!root) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      // A toolbar jump owns activePath while its animation flies — mid-flight
      // frames must not re-spy it back to a block the ride is passing through.
      if (scrollAnimating.current) return;
      const pane = root.getBoundingClientRect();
      // Measured against the pane's own box, NOT the sticky band: while a file is
      // current the band holds that file's own header, so it isn't lost height.
      const paneH = pane.height;
      const blocks = root.querySelectorAll("[data-file]");
      const last = blocks[blocks.length - 1] ?? null;
      // At the end of the scroll there is nothing left to scroll toward, so the
      // last block takes the marker outright. Without this a final file shorter
      // than ~85% of the pane could never win the test above — the file before it
      // still fills the screen — so it would never be current, and `]` (which
      // indexes on activePath) would stick on its predecessor forever.
      //
      // Only when there IS something to scroll. A pane whose content fits is at
      // its end from the first frame, and handing the marker to the last file
      // there is backwards — nothing has been scrolled past. That's also what a
      // cold load looks like: the first measure runs before the content exists
      // (a files review renders one small [data-file] stub per file until its
      // blob lands), so the marker went to the LAST file while the reader was
      // looking at the first. Fall through instead — every block is wholly
      // visible then, so the loop below marks the first one.
      const atEnd =
        root.scrollHeight > root.clientHeight + 1 &&
        root.scrollTop + root.clientHeight >= root.scrollHeight - 1;
      let current: string | null = atEnd ? (last?.getAttribute("data-file") ?? null) : null;
      for (let i = 0; !current && i < blocks.length; i++) {
        const r = blocks[i].getBoundingClientRect();
        if (r.bottom <= pane.top + 1) continue; // scrolled off the top entirely
        if (r.top >= pane.bottom) break; // this one and everything after is below
        // How much of this block the pane is actually showing.
        const shown = Math.min(r.bottom, pane.bottom) - Math.max(r.top, pane.top);
        const clipped = shown < r.height - 1;
        const next = blocks[i + 1];
        current =
          next && clipped && shown < paneH * ACTIVE_HANDOFF_SHARE
            ? next.getAttribute("data-file")
            : blocks[i].getAttribute("data-file");
        break;
      }
      // Nothing intersects (trailing padding under the last block, or a pane
      // shorter than its own chrome) — keep the last file rather than dropping to
      // null, which would unbind every per-file shortcut mid-scroll.
      setActivePath(current ?? last?.getAttribute("data-file") ?? null);
    };
    // rAF-throttle: a wheel/trackpad flick fires many scroll events per frame, but
    // the spy only needs to run once per painted frame. Coalesce them so a fast
    // scroll doesn't repeat the querySelectorAll + getBoundingClientRect sweep
    // dozens of times between frames.
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    // The pane's content mostly arrives AFTER this effect, and none of it fires a
    // scroll event: a files review paints [data-file] stubs until each blob lands,
    // and a fold/unfold restacks everything below it. Without a resize signal the
    // marker would keep whatever it computed against the stubs — the reported "the
    // first file isn't marked on open". The pane's OWN box is worth watching too:
    // its height is the 15% denominator, so a feedback-panel drag or a window
    // resize changes the answer. The pane has exactly one child — the stacked file
    // content (VirtualPaneProvider's wrapper) — so its height is the content height.
    const ro = new ResizeObserver(onScroll);
    ro.observe(root);
    if (root.firstElementChild) ro.observe(root.firstElementChild);
    measure();
    return () => {
      root.removeEventListener("scroll", onScroll);
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [detail, fileListKey]);

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
    (anchor: PendingAnchor, quoteText: string, rect: AnchorRect | null) => {
      const d = getDraft(reviewId);
      const composing = d?.anchor != null && (d.text ?? "").trim() !== "";
      if (composing) {
        if (rect && quoteText.trim())
          setFileQuote({ left: rect.left, top: rect.top, text: quoteText });
        return; // a note is in progress — leave its anchor alone
      }
      setFileQuote(null);
      setComposerAt(rect);
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
      const rect = r
        ? { left: r.left + Math.min(r.width, 320) / 2, top: r.top, bottom: r.bottom }
        : null;
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
      // The card's own box, clipped to a header's worth of height: a file card is
      // most of the pane tall, and a floating composer hung off its BOTTOM would
      // open a screen away from the button that opened it.
      const root = scopeRef.current;
      const scope = patchSeq != null ? `[data-round="${patchSeq}"] ` : "";
      const r = root
        ?.querySelector(`${scope}[data-file="${CSS.escape(file)}"]`)
        ?.getBoundingClientRect();
      setComposerAt(
        r
          ? {
              left: r.left + Math.min(r.width, 360) / 2,
              top: r.top,
              bottom: Math.min(r.top + 32, r.bottom),
            }
          : null,
      );
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

  // Anchor a draft to the file-view selection. Listen at document level: a drag
  // can end over the feedback panel, where the pane's mouseup never fires.
  // getSelectionAnchor is null unless the selection lands on a file line. Coarse
  // pointers never fire a usable mouseup — AddFeedbackPill drives those.
  useEffect(() => {
    if (coarse) return;
    const onMouseUp = () => {
      const root = scopeRef.current;
      if (!root) return;
      const a = getSelectionAnchor(root);
      if (!a) return;
      const sel = window.getSelection();
      const text = sel?.toString() ?? "";
      let rect: AnchorRect | null = null;
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        rect = { left: r.left + r.width / 2, top: r.top, bottom: r.bottom };
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
    setComposerAt(null);
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

  // The review-level edits (approve/abandon/reopen, rename) share the card
  // mutations' snapshot/rollback (`useOptimisticPatch`); there is no onSettled
  // refetch — the PATCH broadcasts a review-updated event this tab receives too.
  // (`remove` below navigates away on success, so there's nothing to keep optimistic.)
  const reviewKey = ["review", reviewId] as const;
  const { beginPatch, restore } = useOptimisticPatch(reviewId);
  // Every review-level edit (approve/abandon/reopen, rename) goes through one PATCH:
  // optimistically patch whichever visible field the body carries (status, title) so
  // the pill/title changes instantly; an invisible one (note→meta.next_steps)
  // reconciles via the review-updated echo the server broadcasts to every tab + the
  // reviews list. (The summary is CLI-only — `r3 edit --summary` — so it's never PATCHed
  // here.)
  const updateReview = useMutation({
    onMutate: async (body: UpdateReviewBody) => {
      const prev = await beginPatch();
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
    onError: (_e, _v, ctx) => restore(ctx?.prev),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteReview(reviewId),
    onSuccess: () => {
      clearDraft(reviewId); // no orphaned draft for a deleted review
      qc.invalidateQueries({ queryKey: ["reviews"] });
      navigate("/");
    },
  });

  // --- Keyboard bindings (keys.ts) ---------------------------------------
  // The Files + View groups: this view owns the scroll-spy's current file, the
  // fold broadcast, the round/snapshot selection, and the layout preference, so
  // it owns their keys. Each handler is the onClick of a control in the pane
  // toolbar or a file header — a shortcut never reaches past the UI.
  //
  // A handler left `undefined` is simply not bound, so a key falls through to
  // nothing rather than doing something surprising: `\` in a files review's plain
  // view has no old/new columns to swap, and `<`/`>` has nothing to step through
  // in a single-round review. Same conditions the toolbar uses to show or hide
  // the corresponding control. (These sit above the early returns below: hooks
  // can't be called conditionally, and there is nothing to bind on a dead view
  // anyway — every handler no-ops on an empty fileList.)
  const hasFiles = fileList.length > 0;
  const canStepVersion = isDiff ? patchMetas.length > 1 : snapshots.length > 0;
  // Where `x` has something to toggle — the same condition that decides whether a
  // file header shows the Viewed pill at all (toggleViewedPath's two branches). A
  // snapshot-diff / pinned-snapshot browse tracks no viewed state, so leave the
  // key UNBOUND there rather than bound-but-silently-inert: an unbound key falls
  // through (and greys its row in the `?` sheet) instead of swallowing the press.
  const canToggleViewed = isDiff ? effectiveRoundSeq != null : liveFilesView;
  useKeyBindings({
    fileNext: hasFiles ? () => jumpFile(1) : undefined,
    filePrev: hasFiles ? () => jumpFile(-1) : undefined,
    // Path-scoped "toggle": the card flips whatever it currently is, matching a
    // click on its own triangle (see FoldSignal).
    fileFold:
      hasFiles && activePath
        ? () =>
            setFoldSignal((s) => ({ mode: "toggle", nonce: (s?.nonce ?? 0) + 1, path: activePath }))
        : undefined,
    // One key, two toolbar buttons — foldAll itself remembers which way is next,
    // so the buttons and the key can't fall out of step.
    foldAll: hasFiles ? () => foldAll(foldAllDir.current) : undefined,
    fileViewed: activePath && canToggleViewed ? () => toggleViewedPath(activePath) : undefined,
    fileNote: activePath ? () => onFileFeedback(activePath, feedbackPatchSeq) : undefined,
    versionNext: canStepVersion ? () => stepVersion(1) : undefined,
    versionPrev: canStepVersion ? () => stepVersion(-1) : undefined,
    // Mobile forces unified regardless of the stored preference, so binding the
    // toggle there would write a preference with no visible effect.
    layoutToggle:
      (isDiff || diffMode) && !isMobile
        ? () => setDiffLayout(diffLayoutPref === "split" ? "unified" : "split")
        : undefined,
    // Fires the dock's own collapse/expand button, which is on screen either way
    // (the header's ›, or the rail itself). Unbound below md: there the bottom
    // sheet is the panel and it has no such control.
    panelToggle: isMobile ? undefined : () => setFeedbackCollapsed(!collapsePref),
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
    fileList.length > 0 || (isDiff && patchMetas.length > 1) || snapshots.length > 0 ? (
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
        // Only where a diff is actually rendered: a files review's plain view has
        // no old/new sides to lay out.
        layoutToggle={isDiff || diffMode ? <DiffLayoutToggle /> : undefined}
        summary={isMobile ? roundSummaryEl : undefined}
        right={
          isDiff && patchMetas.length > 1 ? (
            <RoundSelect
              rounds={patchMetas}
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
      onFocusFeedback={focusFeedback}
      onLocatePin={locatePin}
      onJumpRef={jumpToRef}
      coarse={coarse}
      // Below md the panel stays mounted inside a closed (translated-away,
      // `inert`) sheet — so its keys must stand down until the sheet is up, or
      // they'd fire controls nobody can see.
      keysActive={!isMobile || sheet !== "closed"}
      collapsed={panelCollapsed}
      // Withheld below md: the sheet's own handle is that tier's equivalent
      // control, so the panel must not render a second one inside it.
      onToggleCollapsed={isMobile ? undefined : () => setFeedbackCollapsed(!collapsePref)}
      composerAt={composerAt}
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
        <div className="flex min-w-0 flex-1 flex-col">
          {!isMobile && reviewSummaryEl}
          {!isMobile && paneToolbarEl}
          {/* shiki-surface: syntax theme's editor background, full-bleed. */}
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
              <ProgressiveFileProvider
                scrollRef={scopeRef}
                registry={progressive.registry}
                enabled={progressiveFiles}
              >
                {/* Mobile: header + summary scroll away; toolbar sticks. */}
                {isMobile && (
                  <>
                    {reviewHeader}
                    {reviewSummaryEl}
                    {paneToolbarEl && (
                      <StickyToolbar onHeight={setStickyToolbarH}>{paneToolbarEl}</StickyToolbar>
                    )}
                  </>
                )}
                {!isMobile && roundSummaryEl}
                {isDiff && diff && (
                  <DiffView
                    rounds={fetchedRound ? [fetchedRound] : []}
                    activeSeq={effectiveRoundSeq}
                    isViewed={isViewed}
                    currentPath={activePath}
                    layout={diffLayout}
                    fetchContext={fetchRoundContext}
                    toggle={toggleViewed}
                    onPickLines={onPickLines}
                    onFileFeedback={onFileFeedback}
                    foldSignal={foldSignal}
                    regions={unresolvedRegions}
                  />
                )}
                {isDiff && !diff && (
                  <p
                    className={cn(
                      "p-6 text-sm",
                      diffError ? "text-danger-500" : "text-neutral-400",
                    )}
                  >
                    {diffError ? (diffError as Error).message : "Loading diff…"}
                  </p>
                )}

                {!isDiff &&
                  diffMode &&
                  (snapDiff ? (
                    <DiffView
                      rounds={snapRounds}
                      activeSeq={SNAPSHOT_DIFF_SEQ}
                      currentPath={activePath}
                      layout={diffLayout}
                      fetchContext={fetchSnapContext}
                      // No viewed tracking in a files review's derived diff;
                      // omitting isViewed/toggle hides the toggle.
                      onPickLines={onPickLines}
                      onFileFeedback={onFileFeedback}
                      foldSignal={foldSignal}
                      regions={unresolvedRegions}
                    />
                  ) : (
                    <p className="p-6 text-sm text-neutral-400">Loading diff…</p>
                  ))}

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
                    <ProgressiveFile key={f} path={f} version={progressiveVersion}>
                      {({ active, onHydrated, onOpenChange }) => (
                        <FileView
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
                          onDocLink={openDocLink}
                          hasFile={hasFile}
                          current={f === activePath}
                          foldSignal={foldSignal}
                          unscopedFold={unscopedFold}
                          active={active}
                          ownsFileMarker={false}
                          onHydrated={onHydrated}
                          onOpenChange={onOpenChange}
                          regions={unresolvedRegions}
                        />
                      )}
                    </ProgressiveFile>
                  ))}
              </ProgressiveFileProvider>
            </VirtualPaneProvider>
          </div>
        </div>

        {!isMobile && (
          // Collapsed, the dock is a fixed-width rail: the drag handle goes with
          // it (there is nothing to size), and the inline width must go too, or
          // the last dragged pixel count would survive the collapse and the rail
          // would still be 400px wide.
          <div
            className="relative shrink-0 border-l-2 border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900"
            style={{ width: panelCollapsed ? RAIL_WIDTH : feedbackWidth }}
          >
            {!panelCollapsed && (
              <div
                onPointerDown={onFeedbackResize}
                onDoubleClick={onFeedbackResetSplit}
                title="Drag to resize · double-click to reset"
                className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize transition-colors hover:bg-primary-400/40"
              />
            )}
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
      {/* The `?` cheat sheet. Mounted here, not in App: every binding in the map is
          review-scoped, so on the reviews list the sheet would document keys that
          do nothing. Owns its own open state and the `help` binding. */}
      <ShortcutsOverlay />
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
