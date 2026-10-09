import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArtifactApiError } from "../../../shared/artifact-client.ts";
import {
  type ArtifactDetail,
  type ArtifactDocumentTarget,
  type ArtifactMediaTarget,
  type ArtifactTarget,
  type ArtifactVersion,
  artifactMediaKind,
  type RenderedLocator,
} from "../../../shared/artifacts.ts";
import { hasMessageContent } from "../../../shared/attachments.ts";
import { artifactApi } from "../artifact-api.ts";
import { artifactComposerField, focusArtifactComposer } from "../artifact-composer-keys.ts";
import { activeArtifactDiscussion } from "../artifact-discussions.ts";
import { useOptimisticArtifact } from "../artifact-discussions-status.ts";
import { artifactDrafts, useArtifactNoteOpen, useHasArtifactNote } from "../artifact-drafts.ts";
import {
  type ArtifactLocation,
  artifactWorkspaceSearch,
  defaultFileRepresentation,
  isArtifactDocumentTarget,
  readArtifactLocation,
} from "../artifact-navigation.ts";
import { renderPublishedPreview } from "../artifact-renderer.tsx";
import { artifactViewForTarget, stepArtifactVersion } from "../artifact-version.ts";
import { draftImages } from "../attachment-drafts.ts";
import { AppHeader } from "../components/AppHeader.tsx";
import { ArtifactComparison, type ComparisonSide } from "../components/ArtifactComparison.tsx";
import { ArtifactComposer } from "../components/ArtifactComposer.tsx";
import { ArtifactDiscussionPanel } from "../components/ArtifactDiscussionPanel.tsx";
import { ArtifactFile } from "../components/ArtifactFile.tsx";
import { ArtifactHeader } from "../components/ArtifactHeader.tsx";
import { ArtifactLoading } from "../components/ArtifactLoading.tsx";
import { ArtifactPreviewSecurityProvider } from "../components/ArtifactPreviewSecurity.tsx";
import { ArtifactThreadPopover } from "../components/ArtifactThreadPopover.tsx";
import {
  type ArtifactDiscussionTab,
  type ArtifactRefJump,
  type ArtifactTargetJump,
  ArtifactThreads,
} from "../components/ArtifactThreads.tsx";
import { DiffView } from "../components/DiffView.tsx";
import { FileBrowser } from "../components/FileBrowser.tsx";
import type { FoldSignal } from "../components/FileCard.tsx";
import { ImagePreparation } from "../components/ImagePreparation.tsx";
import { JumpToFile } from "../components/JumpToFile.tsx";
import { QuoteBubble, type QuotePos } from "../components/Message.tsx";
import { Notification, NotificationProvider } from "../components/Notifications.tsx";
import { DiffLayoutToggle, PaneToolbar, TOOLBAR_BTN } from "../components/PaneToolbar.tsx";
import { ShortcutsOverlay } from "../components/ShortcutsOverlay.tsx";
import { keysSuspended, useKeyBindings } from "../keys.ts";
import { markdownCache } from "../markdown-cache.ts";
import { AddDiscussionPill } from "../mobile/AddDiscussionPill.tsx";
// This page is the artifact workspace's single mobile container mount point.
import { MobileComparisonTabs } from "../mobile/MobileComparisonTabs.tsx";
import { MobileReviewChrome, type MobileSheetState } from "../mobile/MobileReviewChrome.tsx";
import { useIsMobile } from "../mobile/useIsMobile.ts";
import { usePointerCoarse } from "../mobile/usePointerCoarse.ts";
import { previewSessions } from "../preview-sessions.ts";
import {
  ProgressiveFile,
  ProgressiveFileProvider,
  useProgressiveFileController,
} from "../progressive.tsx";
import { readingKey, readingPositions } from "../reading-position.ts";
import { type AnchorRect, getSelectionAnchor, type PendingAnchor } from "../selection.ts";
import { composerKeyAction, observeTextSelection } from "../selection-events.ts";
import {
  setDiffLayout,
  setDiscussionMode,
  showDiscussionPanel,
  useDiffLayout,
  useDiscussionMode,
} from "../settings.ts";
import type { DiffSide } from "../types.ts";
import { cn } from "../ui.tsx";
import { type ArtifactCodeJump, useArtifactCodeJump } from "../useArtifactCodeJump.ts";
import { useArtifactComparison } from "../useArtifactComparison.ts";
import { useArtifactContent } from "../useArtifactContent.ts";
import { useFaviconBadge } from "../useFaviconBadge.ts";
import { useReadingPosition } from "../useReadingPosition.ts";
import { useScrollSpy } from "../useScrollSpy.ts";
import { useSyntaxPalette } from "../useSyntaxPalette.ts";
import { diffViewedKey, fileViewedKey } from "../viewed.ts";
import { useVirtualPaneController, VirtualPaneProvider } from "../virtual.tsx";
export interface ArtifactRenderedPaneProps {
  detail: ArtifactDetail;
  version: ArtifactVersion;
  path: string;
  active?: boolean;
  highlightLocated?: boolean;
  independentReading?: boolean;
  previewLabel?: string;
  onLocated?: (state: "anchored" | "ambiguous" | "unplaced") => void;
  commenting: boolean;
  jump: {
    locator: RenderedLocator | null;
    nonce: number;
  } | null;
  navigation?: {
    route: string;
    nonce: number;
  } | null;
  targets: {
    discussionId: string;
    target: ArtifactDocumentTarget;
  }[];
  onTarget: (target: ArtifactDocumentTarget) => void;
  onSelection?: (target: ArtifactDocumentTarget, rect: AnchorRect, quote: boolean) => void;
  onComposerKey?: (action: "focus" | "escape") => void;
  onToggleCommenting?: () => void;
  captureContainer?: HTMLElement | null;
  noteHasText?: boolean;
  composerVisible?: boolean;
  onDocument: (path: string, route?: string) => void;
  onDiscussion: (id: string) => void;
}
export type ArtifactRenderer = (props: ArtifactRenderedPaneProps) => ReactNode;
export function ArtifactView({
  artifactId,
  renderPreview = renderPublishedPreview,
}: {
  artifactId: string;
  renderPreview?: ArtifactRenderer;
}) {
  const query = useQuery({
    queryKey: ["artifact", artifactId],
    queryFn: () => artifactApi.detail(artifactId),
  });
  useEffect(() => {
    document.title = `${query.data?.title || artifactId} · r3`;
  }, [artifactId, query.data?.title]);
  const unavailable =
    query.error instanceof ArtifactApiError && [401, 403, 404, 410].includes(query.error.status);
  useFaviconBadge(!unavailable && (query.data?.unhandledCount ?? 0) > 0);
  useEffect(() => {
    if (unavailable) {
      if (query.error instanceof ArtifactApiError && [401, 403].includes(query.error.status))
        void markdownCache.suspend();
      else void markdownCache.forget(artifactId);
      void draftImages.clear(
        query.error instanceof ArtifactApiError && [401, 403].includes(query.error.status)
          ? undefined
          : artifactId,
      );
      previewSessions.forget(artifactId);
      readingPositions.forget(artifactId);
    }
  }, [unavailable, artifactId, query.error]);
  if (query.error && (!query.data || unavailable))
    return (
      <>
        <AppHeader />
        <main role="alert" className="p-6 text-sm text-red-600">
          {query.error.message}
        </main>
      </>
    );
  if (!query.data)
    return (
      <>
        <AppHeader />
        <main className="flex min-h-0 flex-1">
          <ArtifactLoading />
        </main>
      </>
    );
  return (
    <ArtifactWorkspace
      key={artifactId}
      detail={query.data}
      renderPreview={renderPreview}
      onLocationChange={(view) =>
        history.replaceState(
          history.state,
          "",
          `${location.pathname}${artifactWorkspaceSearch(view, location.search)}`,
        )
      }
    />
  );
}
interface ArtifactWorkspaceProps {
  detail: ArtifactDetail;
  renderPreview: ArtifactRenderer;
  initialSearch?: string;
  onLocationChange?: (view: ArtifactLocation) => void;
}
export function ArtifactWorkspace(props: ArtifactWorkspaceProps) {
  const detail = useOptimisticArtifact(props.detail);
  return (
    <NotificationProvider>
      <ArtifactPreviewSecurityProvider>
        <ImagePreparation>
          <Workspace {...props} detail={detail} />
        </ImagePreparation>
      </ArtifactPreviewSecurityProvider>
    </NotificationProvider>
  );
}
function Workspace({
  detail,
  renderPreview,
  initialSearch = location.search,
  onLocationChange,
}: ArtifactWorkspaceProps) {
  const [view, setView] = useState(() => readArtifactLocation(detail.kind, initialSearch));
  const comparison = useArtifactComparison(detail, initialSearch, !!onLocationChange);
  const [comparisonTab, setComparisonTab] = useState<ArtifactDiscussionTab>("active");
  const [comparisonSide, setComparisonSide] = useState<ComparisonSide>("proposed");
  const preferredLayout = useDiffLayout();
  const mobile = useIsMobile();
  const coarse = usePointerCoarse();
  const layout = mobile ? "unified" : preferredLayout;
  const discussionMode = useDiscussionMode();
  const collapsed = !comparison.active && discussionMode === "hidden";
  const [sheet, setSheet] = useState<MobileSheetState>("closed");
  const [commenting, setCommenting] = useState(false);
  const [captureContainer, setCaptureContainer] = useState<HTMLDivElement | null>(null);
  const [discussionTab, setDiscussionTab] = useState<ArtifactDiscussionTab>("active");
  const [notice, setNotice] = useState("");
  const [floating, setFloating] = useState<AnchorRect | null>(null);
  const [popoverDiscussion, setPopoverDiscussion] = useState<string | null>(null);
  const [quote, setQuote] = useState<QuotePos | null>(null);
  const [jump, setJump] = useState<ArtifactCodeJump | null>(null);
  const [renderedJump, setRenderedJump] = useState<ArtifactRenderedPaneProps["jump"]>(null);
  const pendingRenderedJump = useRef<ArtifactRenderedPaneProps["jump"]>(null);
  const [renderedNavigation, setRenderedNavigation] =
    useState<ArtifactRenderedPaneProps["navigation"]>(null);
  const pendingRenderedNavigation = useRef<ArtifactRenderedPaneProps["navigation"]>(null);
  const [detailsRequest, setDetailsRequest] = useState(0);
  const [fold, setFold] = useState<FoldSignal | null>(null);
  const [fileViews, setFileViews] = useState<Record<string, "source" | "rendered">>({});
  const [activePath, setActivePath] = useState<string | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const suspendedSpy = useRef(false);
  const jumpNonce = useRef(0);
  const initialDiscussion = useRef(view.discussionId);
  const [searchEntry] = useState(() => new URLSearchParams(initialSearch));
  const initialSearchEntry = useRef(true);
  const initialPath = useRef(view.discussionId ? null : view.path);
  const hasNote = useHasArtifactNote(detail.id);
  const noteOpen = useArtifactNoteOpen(detail.id);
  const {
    version,
    theme,
    viewed,
    filesQuery,
    diffQuery,
    paths,
    path,
    canRender,
    context,
    regions,
    renderedTargets,
    viewedPaths,
    patch,
    fetchContext,
  } = useArtifactContent(detail, view, setNotice);
  const syntaxPalette = useSyntaxPalette(theme, detail.kind !== "html");
  const fileMode = useCallback(
    (filePath: string): "source" | "rendered" =>
      view.path === filePath &&
      (view.representation === "source" || view.representation === "rendered")
        ? view.representation
        : (fileViews[`${version?.seq}:${filePath}`] ?? defaultFileRepresentation(filePath)),
    [view.path, view.representation, fileViews, version?.seq],
  );
  const positionKey =
    version && path && detail.kind !== "html"
      ? readingKey(detail.id, version.seq, path, detail.kind === "files" ? fileMode(path) : "diff")
      : null;
  useEffect(() => {
    if (
      detail.kind === "files" &&
      view.path &&
      version &&
      (view.representation === "source" || view.representation === "rendered")
    ) {
      const key = `${version.seq}:${view.path}`;
      const mode = view.representation;
      setFileViews((current) => (current[key] === mode ? current : { ...current, [key]: mode }));
    }
  }, [detail.kind, version, view.path, view.representation]);
  const virtual = useVirtualPaneController();
  const progressive = useProgressiveFileController();
  const prepareReadingPosition = useCallback(
    (point: { y: number }) =>
      detail.kind !== "files" ||
      (!!paneRef.current && progressive.prepareReadingPosition(paneRef.current, point.y)),
    [detail.kind, progressive.prepareReadingPosition],
  );
  useReadingPosition(
    paneRef,
    positionKey,
    !!jump || !!renderedJump || !!initialDiscussion.current,
    version?.seq ?? null,
    prepareReadingPosition,
  );
  useEffect(() => {
    const toolbar = toolbarRef.current;
    const update = () => {
      const height = `${toolbar?.offsetHeight ?? 0}px`;
      paneRef.current?.style.setProperty("--pane-sticky-h", height);
      splitRef.current?.style.setProperty("--pane-sticky-h", height);
    };
    update();
    if (!toolbar) return;
    const resize = new ResizeObserver(update);
    resize.observe(toolbar);
    return () => resize.disconnect();
  }, []);
  // Pin the first actual publication. New versions are announced and remain an
  // explicit reader choice, including while an unanchored comment is being typed.
  useEffect(() => {
    if (version && view.versionSeq === null)
      setView((current) => ({ ...current, versionSeq: version.seq }));
  }, [version, view.versionSeq]);
  useEffect(() => {
    const restore = () => {
      setView(readArtifactLocation(detail.kind, location.search));
      setPopoverDiscussion(null);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [detail.kind]);
  useEffect(() => {
    onLocationChange?.({
      ...view,
      path,
      representation: detail.kind === "files" && path ? fileMode(path) : view.representation,
      versionSeq: version?.seq ?? view.versionSeq,
    });
  }, [view, path, version?.seq, onLocationChange, detail.kind, fileMode]);
  const changeView = useCallback((patch: Partial<ArtifactLocation>) => {
    initialPath.current = null;
    setView((current) => ({ ...current, ...patch }));
    setJump(null);
    setRenderedJump(null);
    setRenderedNavigation(null);
    pendingRenderedNavigation.current = null;
    setNotice("");
    setPopoverDiscussion(null);
  }, []);
  const selectVersion = (versionSeq: number | null) => {
    comparison.close(false);
    changeView({ versionSeq, ...(detail.kind === "html" ? { path: null } : {}) });
    setActivePath(null);
  };
  const focusComposer = useCallback(
    () => requestAnimationFrame(() => focusArtifactComposer(detail.id)),
    [detail.id],
  );
  const handleComposerKey = useCallback(
    (action: "focus" | "escape") => {
      if (keysSuspended()) return false;
      if (comparison.active) return action === "focus" && focusArtifactComposer(detail.id);
      if (action === "focus") return focusArtifactComposer(detail.id);
      setQuote(null);
      if (!mobile && !collapsed) {
        setDiscussionMode("hidden");
        return true;
      }
      if (!hasMessageContent(artifactDrafts.get(detail.id))) {
        artifactDrafts.clear(detail.id);
        setFloating(null);
        if (mobile) setSheet("closed");
      }
      return true;
    },
    [detail.id, mobile, collapsed, comparison.active],
  );
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const action = composerKeyAction(event);
      if (action && handleComposerKey(action)) event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleComposerKey]);
  useEffect(
    () => () => {
      if (!hasMessageContent(artifactDrafts.get(detail.id))) artifactDrafts.clear(detail.id);
    },
    [detail.id],
  );
  const openComposer = useCallback(
    (rect?: AnchorRect, focus = true) => {
      if (comparison.active) setComparisonTab("active");
      else setDiscussionTab("active");
      setPopoverDiscussion(null);
      if (mobile && !comparison.active) setSheet("peek");
      else if (collapsed)
        setFloating(
          rect ?? { left: innerWidth * 0.6, top: innerHeight * 0.4, bottom: innerHeight * 0.4 },
        );
      requestAnimationFrame(() =>
        artifactComposerField(detail.id)?.closest("form")?.scrollIntoView({ block: "nearest" }),
      );
      if (focus) focusComposer();
    },
    [mobile, collapsed, detail.id, focusComposer, comparison.active],
  );
  const appendQuote = useCallback(
    (text: string) => {
      const draft = artifactDrafts.get(detail.id);
      artifactDrafts.update(detail.id, {
        body: `${draft?.body ?? ""}\n\n${text
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n")}\n`,
      });
      setQuote(null);
      window.getSelection()?.removeAllRanges();
      openComposer();
    },
    [detail.id, openComposer],
  );
  const anchor = useCallback(
    (target: ArtifactTarget, quoteNow = false, position?: AnchorRect, focus = true) => {
      if (detail.state !== "active") return;
      const selection = window.getSelection();
      const rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
      const at =
        position ??
        (rect?.width
          ? { left: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom }
          : { left: innerWidth * 0.5, top: innerHeight * 0.4, bottom: innerHeight * 0.4 });
      if (!artifactDrafts.anchor(detail.id, target)) {
        const text =
          "locator" in target && target.locator && "quote" in target.locator
            ? target.locator.quote
            : undefined;
        if (text) {
          if (quoteNow) appendQuote(text);
          else setQuote({ ...at, text });
        } else {
          setNotice("Finish or discard the current draft before changing its target.");
          openComposer(at, focus);
        }
      } else openComposer(at, focus);
    },
    [detail.state, detail.id, appendQuote, openComposer],
  );
  const selectRendered = useCallback(
    (target: ArtifactDocumentTarget, rect: AnchorRect, quote: boolean) => {
      anchor(target, quote, rect, false);
    },
    [anchor],
  );
  const toggleCommenting =
    detail.kind === "html" ||
    (detail.kind === "files" && paths.some((path) => fileMode(path) === "rendered"))
      ? () => setCommenting((current) => !current)
      : undefined;
  const selectionProps = {
    onSelection: selectRendered,
    onComposerKey: handleComposerKey,
    onToggleCommenting: toggleCommenting,
    noteHasText: hasNote,
    composerVisible:
      noteOpen &&
      discussionTab === "active" &&
      (mobile ? sheet !== "closed" : !collapsed || !!floating),
  };
  const pickLines = useCallback(
    (file: string, side: DiffSide, start: number, end: number, quote: string) => {
      if (!version) return;
      anchor(
        detail.kind === "diff"
          ? {
              kind: "diff",
              versionSeq: version.seq,
              path: file,
              locator: { start, end, quote, side },
            }
          : { kind: "source", versionSeq: version.seq, path: file, locator: { start, end, quote } },
        false,
        undefined,
        false,
      );
    },
    [version, detail.kind, anchor],
  );
  const selectText = useCallback(
    (pending: PendingAnchor, rawQuote?: string) => {
      if (
        !version ||
        pending.lineStart === null ||
        pending.lineEnd === null ||
        pending.quote === null
      )
        return;
      const target: ArtifactTarget =
        detail.kind === "diff"
          ? {
              kind: "diff",
              versionSeq: version.seq,
              path: pending.file,
              locator: {
                start: pending.lineStart,
                end: pending.lineEnd,
                quote: pending.quote,
                side: pending.side ?? "new",
              },
            }
          : {
              kind: "source",
              versionSeq: version.seq,
              path: pending.file,
              locator: { start: pending.lineStart, end: pending.lineEnd, quote: pending.quote },
            };
      if (rawQuote && hasMessageContent(artifactDrafts.get(detail.id))) appendQuote(rawQuote);
      else anchor(target, false, undefined, false);
    },
    [version, detail.kind, detail.id, appendQuote, anchor],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: navigation cancels pending selection capture
  useEffect(() => {
    if (coarse) return;
    return observeTextSelection(
      () => {
        if (keysSuspended()) return false;
        const selection = paneRef.current && getSelectionAnchor(paneRef.current);
        if (!selection) return false;
        selectText(selection);
        return true;
      },
      () => setQuote(null),
      () => false,
    );
  }, [coarse, selectText, view]);
  const [mediaJump, setMediaJump] = useState<{
    target: ArtifactMediaTarget;
    nonce: number;
  } | null>(null);
  const locate = useCallback<ArtifactTargetJump>(
    (target, discussionId) => {
      comparison.close(false);
      const next = artifactViewForTarget(detail.kind, target, view);
      changeView({ ...next, ...(discussionId ? { discussionId } : {}) });
      setSheet("closed");
      const nonce = ++jumpNonce.current;
      if (isArtifactDocumentTarget(target)) {
        if (target.kind === "media") {
          setMediaJump({ target, nonce });
          setJump({ path: target.path, side: "new", nonce });
          setFold({ mode: "unfold", path: target.path, nonce });
        } else if (target.kind === "rendered") {
          if (detail.kind === "files") {
            // Hydrate/unfold and finish aligning the file header before the
            // rendered target can scroll that same outer content pane.
            setRenderedJump(null);
            pendingRenderedJump.current = { locator: target.locator, nonce };
            setJump({ path: target.path, side: "new", nonce });
            setFold({ mode: "unfold", path: target.path, nonce });
          } else setRenderedJump({ locator: target.locator, nonce });
        } else {
          setJump({
            path: target.path,
            start: target.locator?.start,
            end: target.locator?.end,
            side: target.kind === "diff" ? (target.locator?.side ?? "new") : "new",
            nonce,
          });
          setFold({ mode: "unfold", path: target.path, nonce });
        }
      } else if (target.kind === "version_summary") {
        setDetailsRequest(nonce);
      } else if (target.kind === "artifact_summary") {
        setNotice(
          "This comment refers to a retired artifact overview. Its original target and quote are preserved.",
        );
      } else paneRef.current?.scrollTo({ top: 0 });
    },
    [detail.kind, view, changeView, comparison.close],
  );
  useEffect(() => {
    const id = initialDiscussion.current;
    if (!initialSearchEntry.current) return;
    initialSearchEntry.current = false;
    initialDiscussion.current = null;
    if (!id) {
      const line = searchEntry.get("line");
      if (view.versionSeq !== null && searchEntry.get("summary") === "1") {
        locate({ kind: "version_summary", versionSeq: view.versionSeq, locator: null });
      } else if (
        view.versionSeq !== null &&
        view.path &&
        view.representation === "rendered" &&
        searchEntry.get("text")
      ) {
        locate({
          kind: "rendered",
          versionSeq: view.versionSeq,
          path: view.path,
          locator: { selector: "body", quote: searchEntry.get("text")!.slice(0, 240) },
        });
      } else if (
        view.versionSeq !== null &&
        view.path &&
        line &&
        /^[1-9]\d*$/.test(line) &&
        Number.isSafeInteger(Number(line))
      ) {
        const locator = { start: Number(line), end: Number(line), quote: "" };
        if (view.representation === "source")
          locate({ kind: "source", versionSeq: view.versionSeq, path: view.path, locator });
        else if (view.representation === "diff")
          locate({
            kind: "diff",
            versionSeq: view.versionSeq,
            path: view.path,
            locator: { ...locator, side: searchEntry.get("side") === "old" ? "old" : "new" },
          });
      }
      return;
    }
    const discussions = detail.discussions.find((discussions) => discussions.id === id);
    if (!discussions) {
      setNotice("This conversation is unavailable.");
      return;
    }
    const commentId = searchEntry.get("comment");
    if (commentId) {
      const comment = discussions.comments.slice(1).find((comment) => comment.id === commentId);
      if (!comment) setNotice("This comment is unavailable.");
      else if (comment.context.versionSeq === null)
        setNotice("This comment has no recorded publication context.");
    } else locate(discussions.target, id);
    if (mobile) setSheet("full");
    else showDiscussionPanel();
  }, [detail.discussions, locate, mobile, searchEntry, view]);
  const jumpRef = useCallback<ArtifactRefJump>(
    (ref, messageContext) => {
      comparison.close(false);
      if (!messageContext.versionSeq || !messageContext.representation) {
        setNotice("This reference has no known published representation.");
        return;
      }
      changeView({
        versionSeq: messageContext.versionSeq,
        representation: messageContext.representation,
        path: ref.file,
      });
      setSheet("closed");
      if (messageContext.representation !== "rendered") {
        const nonce = ++jumpNonce.current;
        setJump({ path: ref.file, start: ref.lineStart, end: ref.lineEnd, side: "new", nonce });
        setFold({ mode: "unfold", path: ref.file, nonce });
      } else
        setNotice(
          "Opened the referenced rendered document. Source line numbers do not identify rendered elements.",
        );
    },
    [changeView, comparison.close],
  );
  const showDiscussion = useCallback(
    (discussionId: string) => {
      setView((current) => ({ ...current, discussionId }));
      if (mobile) setSheet("full");
      else if (collapsed) {
        setFloating(null);
        setPopoverDiscussion(discussionId);
      }
    },
    [mobile, collapsed],
  );
  useEffect(() => {
    if (mobile || !collapsed) setPopoverDiscussion(null);
  }, [mobile, collapsed]);
  const visibleThread = detail.discussions.find(
    (discussions) => discussions.id === popoverDiscussion,
  );
  const selectFile = useCallback(
    (path: string) => {
      changeView({ path, representation: detail.kind === "diff" ? "diff" : fileMode(path) });
      setActivePath(path);
      setSheet("closed");
      const nonce = ++jumpNonce.current;
      setJump({ path, side: "new", nonce });
      setFold({ mode: "unfold", path, nonce });
    },
    [changeView, detail.kind, fileMode],
  );
  const canonicalJump = useMemo(
    () =>
      jump
        ? {
            ...jump,
            path: diffQuery.data?.find((file) => file.oldPath === jump.path)?.path ?? jump.path,
          }
        : null,
    [jump, diffQuery.data],
  );
  const ready = detail.kind === "diff" ? !!diffQuery.data : !!filesQuery.data;
  useEffect(() => {
    if (!ready || detail.kind === "html" || !initialPath.current) return;
    const path = initialPath.current;
    initialPath.current = null;
    if (positionKey && readingPositions.get(positionKey)) return;
    const nonce = ++jumpNonce.current;
    setJump({ path, side: "new", nonce });
    setFold({ mode: "unfold", path, nonce });
  }, [ready, detail.kind, positionKey]);
  const finishCodeJump = useCallback((nonce: number) => {
    if (jumpNonce.current !== nonce) return;
    if (pendingRenderedJump.current?.nonce === nonce) {
      setRenderedJump(pendingRenderedJump.current);
      pendingRenderedJump.current = null;
    }
    if (pendingRenderedNavigation.current?.nonce === nonce) {
      setRenderedNavigation(pendingRenderedNavigation.current);
      pendingRenderedNavigation.current = null;
    }
  }, []);
  useArtifactCodeJump({
    scopeRef: paneRef,
    jump: canonicalJump,
    seq: detail.kind === "diff" ? (version?.seq ?? null) : null,
    ready,
    scrollToLine: virtual.scrollToLine,
    activate: progressive.activate,
    onSettled: finishCodeJump,
  });
  useScrollSpy({
    paneRef,
    setActivePath,
    suspended: suspendedSpy,
    ready: ready && detail.kind !== "html",
    fileList: paths,
  });
  const currentPath = detail.kind === "html" ? path : (activePath ?? paths[0]);
  const currentFile = filesQuery.data?.find((file) => file.path === currentPath);
  const wholeFile = () => {
    if (version && currentPath)
      anchor({
        kind: detail.kind === "diff" ? "diff" : currentPath ? fileMode(currentPath) : "source",
        versionSeq: version.seq,
        path: currentPath,
        locator: null,
      });
  };
  const toggleViewed = () => {
    if (detail.kind === "diff" && version && currentPath)
      viewed.toggle(diffViewedKey(version.seq, currentPath));
    else if (currentFile) viewed.toggle(fileViewedKey(currentFile.path, currentFile.hash));
  };
  const stepFile = (direction: -1 | 1) => {
    const at = paths.indexOf(currentPath ?? "");
    const next = paths[Math.max(0, Math.min(paths.length - 1, at + direction))];
    if (next) selectFile(next);
  };
  const foldAll = (requested?: "fold" | "unfold") => {
    const mode =
      requested ??
      (paneRef.current?.querySelector('[data-file] button[title="Collapse"]') ? "fold" : "unfold");
    setFold({ mode, nonce: ++jumpNonce.current });
  };
  useKeyBindings({
    commentModeToggle: comparison.active ? undefined : toggleCommenting,
    generalNote: (mobile ? sheet !== "closed" : !collapsed)
      ? () => anchor({ kind: "artifact" })
      : undefined,
    panelHide:
      !comparison.active && !mobile && !collapsed ? () => setDiscussionMode("hidden") : undefined,
    panelToggle: comparison.active
      ? undefined
      : () => {
          if (mobile) setSheet(sheet === "closed" ? "full" : "closed");
          else if (collapsed) showDiscussionPanel();
          else setDiscussionMode("hidden");
        },
    ...(!comparison.active && version
      ? {
          versionNext: () => selectVersion(stepArtifactVersion(detail.versions, version.seq, 1)),
          versionPrev: () => selectVersion(stepArtifactVersion(detail.versions, version.seq, -1)),
        }
      : {}),
    ...(!comparison.active && detail.kind !== "html"
      ? {
          fileNext: () => stepFile(1),
          filePrev: () => stepFile(-1),
          fileViewed: toggleViewed,
          fileNote: wholeFile,
          fileFold: () =>
            setFold({ mode: "toggle", path: currentPath ?? undefined, nonce: ++jumpNonce.current }),
          foldAll: () => foldAll(),
        }
      : {}),
    ...(!comparison.active && detail.kind === "diff" && !mobile
      ? { layoutToggle: () => setDiffLayout(layout === "split" ? "unified" : "split") }
      : {}),
  });
  const toolbar = detail.kind !== "html" && (
    <div ref={toolbarRef} className="sticky top-0 z-20">
      <PaneToolbar
        hasFiles={paths.length > 0}
        filePicker={
          <JumpToFile
            files={paths}
            viewed={viewedPaths}
            activePath={currentPath}
            onSelect={selectFile}
            btnClassName={TOOLBAR_BTN}
          />
        }
        onJump={stepFile}
        onFoldAll={foldAll}
        layoutToggle={detail.kind === "diff" && !mobile ? <DiffLayoutToggle /> : undefined}
      />
    </div>
  );
  const failure = (detail.kind === "diff" ? diffQuery.error : filesQuery.error) ?? viewed.error;
  const composer = (
    <ArtifactComposer
      artifactId={detail.id}
      readOnly={detail.state !== "active"}
      onDone={() => {
        setFloating(null);
        if (mobile) setSheet("closed");
      }}
      floating={
        !mobile && collapsed && floating
          ? { ...floating, onClose: () => setFloating(null) }
          : undefined
      }
    />
  );
  const focusComparison = useCallback(
    (discussionId: string) => {
      const pairs = [...comparison.comparisons.values()].filter(
        (pair) => pair.discussionId === discussionId,
      );
      if (pairs.length) comparison.open(pairs.at(-1)!.commentId);
    },
    [comparison.comparisons, comparison.open],
  );
  const orderedComparisons = useMemo(() => {
    const notes =
      comparisonTab === "active"
        ? activeArtifactDiscussion(detail.discussions)
        : detail.discussions.filter((note) => note.status === "resolved");
    return notes.flatMap((note) =>
      note.comments.slice(1).flatMap((comment) => {
        const pair = comparison.comparisons.get(comment.id);
        return pair ? [pair] : [];
      }),
    );
  }, [comparisonTab, detail.discussions, comparison.comparisons]);
  const comparisonPosition = orderedComparisons.findIndex(
    (pair) => pair.commentId === comparison.selected?.commentId,
  );
  const panel = (controls?: ReactNode) => (
    <ArtifactThreads
      detail={detail}
      context={
        comparison.active && comparison.selected
          ? {
              versionSeq: comparison.selected.proposed.versionSeq,
              representation: comparison.selected.proposed.kind,
            }
          : context
      }
      tab={comparison.active ? comparisonTab : discussionTab}
      onTabChange={comparison.active ? setComparisonTab : setDiscussionTab}
      onLocate={locate}
      onJumpRef={jumpRef}
      activeDiscussion={comparison.active ? comparison.selected?.discussionId : view.discussionId}
      activeCommentId={
        comparison.active ? comparison.selected?.commentId : searchEntry.get("comment")
      }
      onFocusDiscussion={comparison.active ? focusComparison : showDiscussion}
      comparisons={comparison.comparisons}
      onCompare={comparison.open}
      comparisonMode={comparison.active}
      composer={composer}
      keysActive={comparison.active || (mobile ? sheet !== "closed" : !collapsed)}
      onNewNote={() => anchor({ kind: "artifact" })}
      panelControls={controls}
    />
  );
  const diffLocate = useMemo(
    () =>
      canonicalJump?.start !== undefined
        ? {
            path: canonicalJump.path,
            line: canonicalJump.start,
            side: canonicalJump.side,
            nonce: canonicalJump.nonce,
          }
        : undefined,
    [canonicalJump],
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ArtifactHeader
        detail={detail}
        version={version}
        selectedVersion={view.versionSeq}
        onSelectVersion={selectVersion}
        discussionVisible={!collapsed}
        discussionLocked={comparison.active}
        onToggleDiscussion={
          !mobile
            ? () => (collapsed ? showDiscussionPanel() : setDiscussionMode("hidden"))
            : undefined
        }
        detailsRequest={detailsRequest}
        onJumpRef={(ref) => jumpRef(ref, context)}
        commenting={!comparison.active && commenting}
        onToggleCommenting={toggleCommenting}
        commentingLocked={comparison.active || detail.state !== "active"}
        captureRef={setCaptureContainer}
      />
      <main ref={splitRef} className="relative flex min-h-0 flex-1">
        {!mobile && !comparison.active && detail.kind !== "html" && (
          <FileBrowser
            files={paths}
            defaultCollapsed={detail.kind === "files" && paths.length === 1}
            viewed={viewedPaths}
            activePath={currentPath}
            onSelect={selectFile}
          />
        )}
        <div
          className="relative isolate flex min-h-0 min-w-0 flex-1 overflow-clip"
          data-artifact-content-view
        >
          <div
            data-comparison-track
            className="flex w-[200%] shrink-0 transition-transform duration-[480ms] ease-[cubic-bezier(.22,.78,.2,1)] motion-reduce:transition-none"
            style={{ transform: comparison.active ? "translateX(-50%)" : "translateX(0)" }}
          >
            <div
              data-artifact-surface
              inert={comparison.active}
              aria-hidden={comparison.active}
              className="flex min-h-0 w-1/2 shrink-0"
            >
              {/* biome-ignore lint/a11y/useKeyWithClickEvents: row highlighting is an extra pointer shortcut; every thread has a keyboard-accessible Locate control. */}
              <div
                ref={paneRef}
                data-artifact-content
                style={{
                  ...syntaxPalette,
                  overflowAnchor: detail.kind === "files" ? "none" : undefined,
                }}
                className={cn(
                  "min-h-0 min-w-0 flex-1 overflow-y-auto",
                  !mobile && "[contain:paint]",
                  detail.kind === "html" && "flex flex-col [&>*]:shrink-0",
                )}
                onClick={(event) => {
                  if (!(event.target instanceof Element) || !window.getSelection()?.isCollapsed)
                    return;
                  if (event.target.closest("[data-gutter], button, a, input, textarea")) return;
                  const row = event.target.closest<HTMLElement>("[data-fb-id]");
                  if (row?.dataset.fbId) showDiscussion(row.dataset.fbId);
                }}
              >
                {toolbar}
                {notice && (
                  <Notification
                    title="Review notice"
                    message={notice}
                    tone="warning"
                    onDismiss={() => setNotice("")}
                  />
                )}
                {failure && (
                  <p role="alert" className="p-4 text-sm text-red-600">
                    {failure.message}
                  </p>
                )}
                {!version ? (
                  <p className="p-6 text-sm text-neutral-500">
                    {view.versionSeq === null
                      ? "No version has been published yet."
                      : `Version ${view.versionSeq} is unavailable. Choose a retained publication above.`}
                  </p>
                ) : detail.kind === "html" ? (
                  path && canRender ? (
                    renderPreview({
                      detail,
                      version,
                      path,
                      commenting: detail.state === "active" && !comparison.active && commenting,
                      active: !comparison.active,
                      captureContainer: comparison.active ? null : captureContainer,
                      jump: renderedJump,
                      targets: renderedTargets,
                      onTarget: anchor,
                      ...selectionProps,
                      onDocument: (next) => {
                        if (next !== path) {
                          setRenderedJump(null);
                          setPopoverDiscussion(null);
                        }
                        setView((current) =>
                          current.path === next ? current : { ...current, path: next },
                        );
                      },
                      onDiscussion: showDiscussion,
                    })
                  ) : filesQuery.isPending ? (
                    <ArtifactLoading />
                  ) : (
                    <p className="p-6 text-sm text-neutral-500">
                      This file has no rendered document in the selected version.
                    </p>
                  )
                ) : (
                  <VirtualPaneProvider scrollRef={paneRef} registry={virtual.registry}>
                    <ProgressiveFileProvider
                      scrollRef={paneRef}
                      registry={progressive.registry}
                      enabled={
                        paths.length >= 24 ||
                        (detail.kind === "files" &&
                          !!filesQuery.data?.some((file) => file.renderedHash))
                      }
                      preloadMargin={detail.kind === "files" ? 0 : undefined}
                    >
                      {detail.kind === "diff" ? (
                        diffQuery.isPending ? (
                          <p className="p-6 text-sm text-neutral-500">Loading published patch…</p>
                        ) : (
                          <DiffView
                            patch={patch}
                            layout={layout}
                            fetchContext={fetchContext}
                            isViewed={viewed.isViewed}
                            toggle={viewed.toggle}
                            currentPath={currentPath}
                            onPickLines={pickLines}
                            onFileDiscussion={(path) =>
                              anchor({ kind: "diff", versionSeq: version.seq, path, locator: null })
                            }
                            foldSignal={
                              canonicalJump && fold && fold.path === jump?.path
                                ? { ...fold, path: canonicalJump.path }
                                : fold
                            }
                            regions={regions}
                            locate={diffLocate}
                            progressiveVersion={`${version.seq}:${theme}`}
                          />
                        )
                      ) : filesQuery.data ? (
                        filesQuery.data.map((file) => (
                          <ProgressiveFile
                            key={`${version.seq}:${file.path}`}
                            path={file.path}
                            version={`${version.seq}:${theme}`}
                            initialHeight={file.renderedHash ? "100dvh" : undefined}
                            retain={
                              (!!file.renderedHash && fileMode(file.path) === "rendered") ||
                              !!artifactMediaKind(file.mediaType)
                            }
                          >
                            {({ active, onHydrated, onOpenChange }) => (
                              <ArtifactFile
                                artifactId={detail.id}
                                versionSeq={version.seq}
                                file={file}
                                theme={theme}
                                active={active}
                                current={currentPath === file.path}
                                representation={fileMode(file.path)}
                                onRepresentation={(representation) => {
                                  progressive.activate(file.path);
                                  changeView({ path: file.path, representation });
                                }}
                                viewed={viewed.isViewed(fileViewedKey(file.path, file.hash))}
                                onViewed={() => viewed.toggle(fileViewedKey(file.path, file.hash))}
                                onFileDiscussion={() =>
                                  anchor({
                                    kind: fileMode(file.path),
                                    versionSeq: version.seq,
                                    path: file.path,
                                    locator: null,
                                  })
                                }
                                onMediaTarget={(target, snapshot) => {
                                  if (!artifactDrafts.anchor(detail.id, target)) {
                                    setNotice(
                                      "Finish or discard the current draft before changing its target.",
                                    );
                                    openComposer(undefined, false);
                                    return false;
                                  }
                                  artifactDrafts.update(detail.id, { mediaSnapshot: snapshot });
                                  artifactDrafts.flush();
                                  openComposer(undefined, false);
                                  return true;
                                }}
                                mediaJump={
                                  mediaJump?.target.path === file.path &&
                                  mediaJump.target.versionSeq === version.seq
                                    ? mediaJump
                                    : null
                                }
                                mediaActive={!comparison.active}
                                fold={fold}
                                onHydrated={onHydrated}
                                onOpenChange={onOpenChange}
                                regions={regions}
                                onPickLines={(side, start, end, quote) =>
                                  pickLines(file.path, side, start, end, quote)
                                }
                                preview={() =>
                                  renderPreview({
                                    detail,
                                    version,
                                    path: file.path,
                                    commenting:
                                      detail.state === "active" && !comparison.active && commenting,
                                    active: !comparison.active,
                                    jump: view.path === file.path ? renderedJump : null,
                                    navigation: view.path === file.path ? renderedNavigation : null,
                                    targets: renderedTargets,
                                    onTarget: anchor,
                                    ...selectionProps,
                                    onDocument: (next, route) => {
                                      if (next === file.path) return;
                                      changeView({ path: next, representation: "rendered" });
                                      const nonce = ++jumpNonce.current;
                                      pendingRenderedNavigation.current = {
                                        route: route ?? "#",
                                        nonce,
                                      };
                                      setJump({ path: next, side: "new", nonce });
                                      setFold({ mode: "unfold", path: next, nonce });
                                    },
                                    onDiscussion: showDiscussion,
                                  })
                                }
                              />
                            )}
                          </ProgressiveFile>
                        ))
                      ) : (
                        <p className="p-6 text-sm text-neutral-500">Loading published files…</p>
                      )}
                    </ProgressiveFileProvider>
                  </VirtualPaneProvider>
                )}
              </div>
            </div>
            <div
              data-comparison-surface
              inert={!comparison.active}
              aria-hidden={!comparison.active}
              className="flex min-h-0 w-1/2 shrink-0 flex-col"
            >
              {comparison.retained && (
                <>
                  {mobile && (
                    <MobileComparisonTabs side={comparisonSide} onChange={setComparisonSide} />
                  )}
                  <ArtifactComparison
                    detail={detail}
                    comparison={comparison.selected}
                    renderPreview={renderPreview}
                    active={comparison.active}
                    side={mobile ? comparisonSide : undefined}
                    onBack={() => comparison.close()}
                    position={comparisonPosition}
                    count={orderedComparisons.length}
                    onStep={(direction) => {
                      const next = orderedComparisons[comparisonPosition + direction];
                      if (next) comparison.open(next.commentId);
                    }}
                  />
                </>
              )}
            </div>
          </div>
        </div>
        {!mobile && (
          <ArtifactDiscussionPanel
            mode={comparison.active ? "expanded" : discussionMode}
            locked={comparison.active}
            onModeChange={setDiscussionMode}
          >
            {panel}
          </ArtifactDiscussionPanel>
        )}
        {!mobile && collapsed && visibleThread && (
          <div className="pointer-events-none absolute right-2 bottom-2 top-[calc(var(--pane-sticky-h,2rem)+0.5rem)] z-30 flex w-[440px] max-w-[calc(100%-1rem)] flex-col items-stretch [&>*]:pointer-events-auto">
            <ArtifactThreadPopover
              artifactKind={detail.kind}
              agentLabels={detail.agentLabels}
              key={visibleThread.id}
              discussions={visibleThread}
              context={context}
              latestVersionSeq={detail.versions.at(-1)?.seq ?? null}
              onLocate={locate}
              onJumpRef={jumpRef}
              comparisons={comparison.comparisons}
              onCompare={comparison.open}
              onExpand={showDiscussionPanel}
              onClose={() => setPopoverDiscussion(null)}
            />
          </div>
        )}
      </main>
      {mobile && (
        <MobileReviewChrome
          openCount={
            detail.discussions.filter((discussions) => discussions.status === "open").length
          }
          sheet={sheet}
          docked={comparison.active}
          onSetSheet={setSheet}
        >
          {panel()}
        </MobileReviewChrome>
      )}
      {coarse && detail.state === "active" && !comparison.active && (
        <AddDiscussionPill scopeRef={paneRef} composing={hasNote} onAdd={selectText} />
      )}
      {quote && <QuoteBubble pos={quote} label="Quote in note" onQuote={appendQuote} />}
      <ShortcutsOverlay />
    </div>
  );
}
