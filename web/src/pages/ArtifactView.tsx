import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ArtifactDetail,
  ArtifactDocumentTarget,
  ArtifactTarget,
  ArtifactVersion,
  RenderedLocator,
} from "../../../shared/artifacts.ts";
import { artifactApi } from "../artifact-api.ts";
import { artifactDrafts, useHasArtifactNote } from "../artifact-drafts.ts";
import {
  type ArtifactLocation,
  artifactLocationSearch,
  isArtifactDocumentTarget,
  readArtifactLocation,
} from "../artifact-navigation.ts";
import { artifactViewForTarget, stepArtifactVersion } from "../artifact-version.ts";
import { AppHeader } from "../components/AppHeader.tsx";
import { ArtifactComposer } from "../components/ArtifactComposer.tsx";
import { ArtifactFile } from "../components/ArtifactFile.tsx";
import { ArtifactHeader } from "../components/ArtifactHeader.tsx";
import { ArtifactLoading } from "../components/ArtifactLoading.tsx";
import { ArtifactPreview } from "../components/ArtifactPreview.tsx";
import { ArtifactPreviewSecurityProvider } from "../components/ArtifactPreviewSecurity.tsx";
import { ArtifactThreadPopover } from "../components/ArtifactThreadPopover.tsx";
import {
  type ArtifactRefJump,
  type ArtifactTargetJump,
  ArtifactThreads,
} from "../components/ArtifactThreads.tsx";
import { ArtifactOpenLatest } from "../components/ArtifactVersionSelect.tsx";
import { DiffView } from "../components/DiffView.tsx";
import { FeedbackPanelControls } from "../components/FeedbackPanelControls.tsx";
import { FileBrowser } from "../components/FileBrowser.tsx";
import type { FoldSignal } from "../components/FileCard.tsx";
import { JumpToFile } from "../components/JumpToFile.tsx";
import { QuoteBubble, type QuotePos } from "../components/Message.tsx";
import { DiffLayoutToggle, PaneToolbar, TOOLBAR_BTN } from "../components/PaneToolbar.tsx";
import { ShortcutsOverlay } from "../components/ShortcutsOverlay.tsx";
import { useKeyBindings } from "../keys.ts";
// This page is the artifact workspace's single mobile container mount point.
import { AddFeedbackPill } from "../mobile/AddFeedbackPill.tsx";
import { MobileReviewChrome, type MobileSheetState } from "../mobile/MobileReviewChrome.tsx";
import { useIsMobile } from "../mobile/useIsMobile.ts";
import { usePointerCoarse } from "../mobile/usePointerCoarse.ts";
import {
  ProgressiveFile,
  ProgressiveFileProvider,
  useProgressiveFileController,
} from "../progressive.tsx";
import { type AnchorRect, getSelectionAnchor, type PendingAnchor } from "../selection.ts";
import {
  setDiffLayout,
  setFeedbackMode,
  showFeedbackPanel,
  useDiffLayout,
  useFeedbackMode,
} from "../settings.ts";
import type { DiffSide } from "../types.ts";
import { cn, useResizableWidth } from "../ui.tsx";
import { type ArtifactCodeJump, useArtifactCodeJump } from "../useArtifactCodeJump.ts";
import { useArtifactContent } from "../useArtifactContent.ts";
import { useScrollSpy } from "../useScrollSpy.ts";
import { useSyntaxPalette } from "../useSyntaxPalette.ts";
import { diffViewedKey, fileViewedKey } from "../viewed.ts";
import { useVirtualPaneController, VirtualPaneProvider } from "../virtual.tsx";

export interface ArtifactRenderedPaneProps {
  detail: ArtifactDetail;
  version: ArtifactVersion;
  path: string;
  commenting: boolean;
  jump: { locator: RenderedLocator | null; nonce: number } | null;
  targets: { feedbackId: string; target: ArtifactDocumentTarget }[];
  onTarget: (target: ArtifactDocumentTarget) => void;
  onDocument: (path: string) => void;
  onFeedback: (id: string) => void;
}
export type ArtifactRenderer = (props: ArtifactRenderedPaneProps) => ReactNode;
const renderPublishedPreview: ArtifactRenderer = (props) => <ArtifactPreview {...props} />;

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
  if (query.error)
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
          null,
          "",
          `${location.pathname}${artifactLocationSearch(view, view.feedbackId)}`,
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
  return (
    <ArtifactPreviewSecurityProvider>
      <Workspace {...props} />
    </ArtifactPreviewSecurityProvider>
  );
}

function Workspace({
  detail,
  renderPreview,
  initialSearch = location.search,
  onLocationChange,
}: ArtifactWorkspaceProps) {
  const [view, setView] = useState(() => readArtifactLocation(detail.kind, initialSearch));
  const preferredLayout = useDiffLayout();
  const mobile = useIsMobile();
  const coarse = usePointerCoarse();
  const layout = mobile ? "unified" : preferredLayout;
  const feedbackMode = useFeedbackMode();
  const collapsed = feedbackMode === "hidden";
  const [sheet, setSheet] = useState<MobileSheetState>("closed");
  const [commenting, setCommenting] = useState(false);
  const [notice, setNotice] = useState("");
  const [floating, setFloating] = useState<AnchorRect | null>(null);
  const [popoverFeedback, setPopoverFeedback] = useState<string | null>(null);
  const [quote, setQuote] = useState<QuotePos | null>(null);
  const [jump, setJump] = useState<ArtifactCodeJump | null>(null);
  const [renderedJump, setRenderedJump] = useState<ArtifactRenderedPaneProps["jump"]>(null);
  const [detailsRequest, setDetailsRequest] = useState(0);
  const [fold, setFold] = useState<FoldSignal | null>(null);
  const [fileViews, setFileViews] = useState<Record<string, "source" | "rendered">>({});
  const [activePath, setActivePath] = useState<string | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const suspendedSpy = useRef(false);
  const jumpNonce = useRef(0);
  const initialFeedback = useRef(view.feedbackId);
  const initialPath = useRef(view.feedbackId ? null : view.path);
  const hasNote = useHasArtifactNote(detail.id);
  const {
    version,
    latest,
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
    rounds,
    fetchContext,
  } = useArtifactContent(detail, view, setNotice);
  const syntaxPalette = useSyntaxPalette(theme);
  const fileMode = (filePath: string): "source" | "rendered" =>
    view.path === filePath && view.representation !== "diff"
      ? view.representation
      : (fileViews[`${version?.seq}:${filePath}`] ?? "source");
  useEffect(() => {
    if (detail.kind === "files" && view.path && version && view.representation !== "diff") {
      const key = `${version.seq}:${view.path}`;
      const mode = view.representation;
      setFileViews((current) => (current[key] === mode ? current : { ...current, [key]: mode }));
    }
  }, [detail.kind, version, view.path, view.representation]);
  const virtual = useVirtualPaneController();
  const progressive = useProgressiveFileController();
  const resize = useResizableWidth("r3-feedback-width", {
    min: 300,
    max: 700,
    defaultFraction: 0.382,
    containerRef: splitRef,
  });
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
  useEffect(() => {
    const dismiss = () => setQuote(null);
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismiss();
        setFloating(null);
      }
    };
    document.addEventListener("scroll", dismiss, true);
    window.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("keydown", onEscape);
    };
  }, []);

  // Pin the first actual publication. New versions are announced and remain an
  // explicit reader choice, including while an unanchored reply is being typed.
  useEffect(() => {
    if (version && view.versionSeq === null)
      setView((current) => ({ ...current, versionSeq: version.seq }));
  }, [version, view.versionSeq]);
  useEffect(() => {
    const restore = () => {
      setView(readArtifactLocation(detail.kind, location.search));
      setPopoverFeedback(null);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [detail.kind]);

  useEffect(() => {
    onLocationChange?.({ ...view, path, versionSeq: version?.seq ?? view.versionSeq });
  }, [view, path, version?.seq, onLocationChange]);

  const changeView = useCallback((patch: Partial<ArtifactLocation>) => {
    initialPath.current = null;
    setView((current) => ({ ...current, ...patch }));
    setJump(null);
    setRenderedJump(null);
    setNotice("");
    setPopoverFeedback(null);
  }, []);
  const selectVersion = (versionSeq: number | null) => {
    changeView({ versionSeq, ...(detail.kind === "html" ? { path: null } : {}) });
    setActivePath(null);
    paneRef.current?.scrollTo({ top: 0 });
  };
  const focusComposer = useCallback(
    () =>
      requestAnimationFrame(() => {
        const textarea = document.querySelector<HTMLTextAreaElement>(
          `[data-artifact-composer="${CSS.escape(detail.id)}"]:not([data-reply-to]) textarea`,
        );
        textarea?.focus();
        if (textarea) textarea.setSelectionRange(textarea.value.length, textarea.value.length);
      }),
    [detail.id],
  );
  const openComposer = useCallback(
    (rect?: AnchorRect) => {
      setPopoverFeedback(null);
      if (mobile) setSheet("peek");
      else if (collapsed)
        setFloating(
          rect ?? { left: innerWidth * 0.6, top: innerHeight * 0.4, bottom: innerHeight * 0.4 },
        );
      focusComposer();
    },
    [mobile, collapsed, focusComposer],
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
      openComposer();
    },
    [detail.id, openComposer],
  );
  const anchor = useCallback(
    (target: ArtifactTarget, quoteNow = false) => {
      const selection = window.getSelection();
      const rect = selection?.rangeCount ? selection.getRangeAt(0).getBoundingClientRect() : null;
      const at = rect?.width
        ? { left: rect.left + rect.width / 2, top: rect.top, bottom: rect.bottom }
        : { left: innerWidth * 0.5, top: innerHeight * 0.4, bottom: innerHeight * 0.4 };
      if (!artifactDrafts.anchor(detail.id, target)) {
        const text = "locator" in target ? target.locator?.quote : undefined;
        if (text) {
          if (quoteNow) appendQuote(text);
          else setQuote({ ...at, text });
        } else {
          setNotice("Finish or discard the current draft before changing its target.");
          openComposer(at);
        }
      } else openComposer(at);
    },
    [detail.id, appendQuote, openComposer],
  );
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
      if (rawQuote && artifactDrafts.get(detail.id)?.body.trim()) appendQuote(rawQuote);
      else anchor(target);
    },
    [version, detail.kind, detail.id, appendQuote, anchor],
  );

  const locate = useCallback<ArtifactTargetJump>(
    (target, feedbackId) => {
      const next = artifactViewForTarget(detail.kind, target, view);
      changeView({ ...next, ...(feedbackId ? { feedbackId } : {}) });
      setSheet("closed");
      const nonce = ++jumpNonce.current;
      if (isArtifactDocumentTarget(target)) {
        if (target.kind === "rendered") {
          setRenderedJump({ locator: target.locator, nonce });
          if (detail.kind === "files") {
            setJump({ path: target.path, side: "new", nonce });
            setFold({ mode: "unfold", path: target.path, nonce });
          }
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
    [detail.kind, view, changeView],
  );
  useEffect(() => {
    const id = initialFeedback.current;
    if (!id) return;
    initialFeedback.current = null;
    const feedback = detail.feedback.find((feedback) => feedback.id === id);
    if (feedback) locate(feedback.target, id);
    else setNotice("This conversation is unavailable.");
  }, [detail.feedback, locate]);
  const jumpRef = useCallback<ArtifactRefJump>(
    (ref, messageContext) => {
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
    [changeView],
  );
  const showFeedback = useCallback(
    (feedbackId: string) => {
      setView((current) => ({ ...current, feedbackId }));
      if (mobile) setSheet("full");
      else if (collapsed) {
        setFloating(null);
        setPopoverFeedback(feedbackId);
      }
    },
    [mobile, collapsed],
  );
  useEffect(() => {
    if (mobile || !collapsed) setPopoverFeedback(null);
  }, [mobile, collapsed]);
  const visibleThread = detail.feedback.find((feedback) => feedback.id === popoverFeedback);
  const selectFile = useCallback(
    (path: string) => {
      changeView({ path, representation: detail.kind === "diff" ? "diff" : "source" });
      setActivePath(path);
      setSheet("closed");
      const nonce = ++jumpNonce.current;
      setJump({ path, side: "new", nonce });
      setFold({ mode: "unfold", path, nonce });
    },
    [changeView, detail.kind],
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
    const nonce = ++jumpNonce.current;
    setJump({ path, side: "new", nonce });
    setFold({ mode: "unfold", path, nonce });
  }, [ready, detail.kind]);
  useArtifactCodeJump({
    scopeRef: paneRef,
    jump: canonicalJump,
    seq: detail.kind === "diff" ? (version?.seq ?? null) : null,
    ready,
    scrollToLine: virtual.scrollToLine,
    activate: progressive.activate,
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
    generalNote: (mobile ? sheet !== "closed" : !collapsed)
      ? () => anchor({ kind: "artifact" })
      : undefined,
    panelToggle: () => {
      if (mobile) setSheet(sheet === "closed" ? "full" : "closed");
      else if (collapsed) showFeedbackPanel();
      else setFeedbackMode("hidden");
    },
    ...(version
      ? {
          versionNext: () => selectVersion(stepArtifactVersion(detail.versions, version.seq, 1)),
          versionPrev: () => selectVersion(stepArtifactVersion(detail.versions, version.seq, -1)),
        }
      : {}),
    ...(detail.kind !== "html"
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
    ...(detail.kind === "diff" && !mobile
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
  const panel = (
    <ArtifactThreads
      detail={detail}
      context={context}
      onLocate={locate}
      onJumpRef={jumpRef}
      activeFeedback={view.feedbackId}
      onFocusFeedback={showFeedback}
      composer={composer}
      keysActive={mobile ? sheet !== "closed" : !collapsed}
      onNewNote={() => anchor({ kind: "artifact" })}
      panelControls={
        !mobile &&
        !collapsed && <FeedbackPanelControls mode={feedbackMode} onChange={setFeedbackMode} />
      }
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
        feedbackVisible={!collapsed}
        onToggleFeedback={
          !mobile ? () => (collapsed ? showFeedbackPanel() : setFeedbackMode("hidden")) : undefined
        }
        detailsRequest={detailsRequest}
        onJumpRef={(ref) => jumpRef(ref, context)}
        commenting={commenting}
        onToggleCommenting={
          detail.kind === "html" || Object.values(fileViews).includes("rendered")
            ? () => setCommenting(!commenting)
            : undefined
        }
      />
      <main ref={splitRef} className="relative flex min-h-0 flex-1">
        {!mobile && detail.kind !== "html" && (
          <FileBrowser
            files={paths}
            viewed={viewedPaths}
            activePath={currentPath}
            onSelect={selectFile}
          />
        )}
        <div className="relative isolate flex min-h-0 min-w-0 flex-1" data-artifact-content-view>
          {/* biome-ignore lint/a11y/useKeyWithClickEvents: row highlighting is an extra pointer shortcut; every thread has a keyboard-accessible Locate control. */}
          <div
            ref={paneRef}
            data-artifact-content
            style={syntaxPalette}
            className={cn(
              "min-h-0 min-w-0 flex-1 overflow-y-auto",
              !mobile && "[contain:paint]",
              detail.kind === "html" && "flex flex-col [&>*]:shrink-0",
            )}
            onMouseUp={(event) => {
              if (
                coarse ||
                (event.target instanceof Element && event.target.closest("[data-gutter]"))
              )
                return;
              const selection = paneRef.current && getSelectionAnchor(paneRef.current);
              if (selection) selectText(selection);
            }}
            onClick={(event) => {
              if (!(event.target instanceof Element) || !window.getSelection()?.isCollapsed) return;
              if (event.target.closest("[data-gutter], button, a, input, textarea")) return;
              const row = event.target.closest<HTMLElement>("[data-fb-id]");
              if (row?.dataset.fbId) showFeedback(row.dataset.fbId);
            }}
          >
            {toolbar}
            {notice && (
              <p
                role="status"
                className="border-b border-neutral-200 p-3 text-sm text-amber-700 dark:border-neutral-800 dark:text-amber-400"
              >
                {notice}
              </p>
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
                  commenting,
                  jump: renderedJump,
                  targets: renderedTargets,
                  onTarget: anchor,
                  onDocument: (next) => {
                    if (next !== path) {
                      setRenderedJump(null);
                      setPopoverFeedback(null);
                    }
                    setView((current) =>
                      current.path === next ? current : { ...current, path: next },
                    );
                  },
                  onFeedback: showFeedback,
                })
              ) : filesQuery.isPending ? (
                <ArtifactLoading label="Loading preview…" />
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
                  enabled={paths.length >= 24}
                >
                  {detail.kind === "diff" ? (
                    diffQuery.isPending ? (
                      <p className="p-6 text-sm text-neutral-500">Loading published patch…</p>
                    ) : (
                      <DiffView
                        rounds={rounds}
                        activeSeq={version.seq}
                        layout={layout}
                        fetchContext={fetchContext}
                        isViewed={viewed.isViewed}
                        toggle={viewed.toggle}
                        currentPath={currentPath}
                        onPickLines={pickLines}
                        onFileFeedback={(path) =>
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
                            onRepresentation={(representation) =>
                              changeView({ path: file.path, representation })
                            }
                            viewed={viewed.isViewed(fileViewedKey(file.path, file.hash))}
                            onViewed={() => viewed.toggle(fileViewedKey(file.path, file.hash))}
                            onFileFeedback={() =>
                              anchor({
                                kind: fileMode(file.path),
                                versionSeq: version.seq,
                                path: file.path,
                                locator: null,
                              })
                            }
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
                                commenting,
                                jump: view.path === file.path ? renderedJump : null,
                                targets: renderedTargets,
                                onTarget: anchor,
                                onDocument: (next) => {
                                  if (next === file.path) return;
                                  changeView({ path: next, representation: "rendered" });
                                  const nonce = ++jumpNonce.current;
                                  setJump({ path: next, side: "new", nonce });
                                  setFold({ mode: "unfold", path: next, nonce });
                                },
                                onFeedback: showFeedback,
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
          <ArtifactOpenLatest
            latest={latest?.seq}
            selected={view.versionSeq}
            onOpen={selectVersion}
          />
        </div>
        {!mobile && (
          <aside
            data-feedback-mode={feedbackMode}
            className={cn(
              "overflow-hidden border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-950",
              feedbackMode === "floating"
                ? "absolute right-2 bottom-2 top-[calc(var(--pane-sticky-h,2rem)+0.5rem)] z-20 max-w-[calc(100%-1rem)] rounded-lg border shadow-xl"
                : collapsed
                  ? "absolute inset-y-0 right-0 pointer-events-none"
                  : "relative shrink-0 border-l",
              !resize.dragging && "transition-[width] duration-200 motion-reduce:transition-none",
            )}
            style={{ width: collapsed ? 0 : resize.width }}
          >
            {!collapsed && (
              <div
                onPointerDown={resize.onPointerDown}
                onDoubleClick={resize.onDoubleClick}
                className="absolute inset-y-0 left-0 z-20 w-1 cursor-col-resize"
              />
            )}
            <div
              inert={collapsed}
              className="h-full"
              style={{ width: resize.width, visibility: collapsed ? "hidden" : undefined }}
            >
              {panel}
            </div>
          </aside>
        )}
        {!mobile && collapsed && visibleThread && (
          <div className="pointer-events-none absolute right-2 bottom-2 top-[calc(var(--pane-sticky-h,2rem)+0.5rem)] z-30 flex w-[440px] max-w-[calc(100%-1rem)] flex-col items-stretch [&>*]:pointer-events-auto">
            <ArtifactThreadPopover
              key={visibleThread.id}
              feedback={visibleThread}
              context={context}
              onLocate={locate}
              onJumpRef={jumpRef}
              onExpand={showFeedbackPanel}
              onClose={() => setPopoverFeedback(null)}
            />
          </div>
        )}
      </main>
      {mobile && (
        <MobileReviewChrome
          openCount={detail.feedback.filter((feedback) => feedback.status === "open").length}
          sheet={sheet}
          onSetSheet={setSheet}
        >
          {panel}
        </MobileReviewChrome>
      )}
      {coarse && view.representation !== "rendered" && (
        <AddFeedbackPill scopeRef={paneRef} composing={hasNote} onAdd={selectText} />
      )}
      {quote && <QuoteBubble pos={quote} label="Quote in note" onQuote={appendQuote} />}
      <ShortcutsOverlay />
    </div>
  );
}
