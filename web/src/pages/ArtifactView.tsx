import { useMutation, useQuery } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ArtifactDetail,
  ArtifactDocumentTarget,
  ArtifactTarget,
  ArtifactVersion,
  RenderedLocator,
} from "../../../shared/artifacts.ts";
import { artifactMediaKind, hasUnsentArtifactFeedback } from "../../../shared/artifacts.ts";
import { artifactApi } from "../artifact-api.ts";
import { artifactDrafts, useHasArtifactDraft, useHasArtifactNote } from "../artifact-drafts.ts";
import {
  type ArtifactLocation,
  artifactLocationSearch,
  isArtifactDocumentTarget,
  readArtifactLocation,
} from "../artifact-navigation.ts";
import { artifactViewForTarget, stepArtifactVersion } from "../artifact-version.ts";
import { ArtifactComposer } from "../components/ArtifactComposer.tsx";
import { ArtifactHeader } from "../components/ArtifactHeader.tsx";
import { ArtifactPreview } from "../components/ArtifactPreview.tsx";
import { ArtifactSummary } from "../components/ArtifactSummary.tsx";
import {
  type ArtifactRefJump,
  type ArtifactTargetJump,
  ArtifactThreads,
} from "../components/ArtifactThreads.tsx";
import { ArtifactVersionSelect } from "../components/ArtifactVersionSelect.tsx";
import { DiffView } from "../components/DiffView.tsx";
import { FileBrowser } from "../components/FileBrowser.tsx";
import { FileCard, type FoldSignal } from "../components/FileCard.tsx";
import { JumpToFile } from "../components/JumpToFile.tsx";
import { QuoteBubble, type QuotePos } from "../components/Message.tsx";
import { ShortcutsOverlay } from "../components/ShortcutsOverlay.tsx";
import { SourceCode } from "../components/SourceCode.tsx";
import { useKeyBindings } from "../keys.ts";
import { HL_ACTIVE, rangeForQuote, setHighlightRanges } from "../mdhighlight.ts";
// This page is the artifact workspace's single mobile container mount point.
import { AddFeedbackPill } from "../mobile/AddFeedbackPill.tsx";
import { MobileReviewChrome, type MobileSheetState } from "../mobile/MobileReviewChrome.tsx";
import { useIsMobile } from "../mobile/useIsMobile.ts";
import { usePointerCoarse } from "../mobile/usePointerCoarse.ts";
import { ProgressiveFileProvider, useProgressiveFileController } from "../progressive.tsx";
import { navigate } from "../router.ts";
import { type AnchorRect, getSelectionAnchor, type PendingAnchor } from "../selection.ts";
import {
  setDiffLayout,
  setFeedbackCollapsed,
  useDiffLayout,
  useFeedbackCollapsed,
} from "../settings.ts";
import type { DiffSide } from "../types.ts";
import { Button, cn, FoldChevrons, useResizableWidth } from "../ui.tsx";
import { type ArtifactCodeJump, useArtifactCodeJump } from "../useArtifactCodeJump.ts";
import { useArtifactContent } from "../useArtifactContent.ts";
import { useScrollSpy } from "../useScrollSpy.ts";
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
      <p role="alert" className="p-6 text-sm text-red-600">
        {query.error.message}
      </p>
    );
  if (!query.data) return <p className="p-6 text-sm text-neutral-500">Loading artifact…</p>;
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

export function ArtifactWorkspace({
  detail,
  renderPreview,
  initialSearch = location.search,
  onLocationChange,
}: {
  detail: ArtifactDetail;
  renderPreview: ArtifactRenderer;
  initialSearch?: string;
  onLocationChange?: (view: ArtifactLocation) => void;
}) {
  const [view, setView] = useState(() => readArtifactLocation(detail.kind, initialSearch));
  const preferredLayout = useDiffLayout();
  const mobile = useIsMobile();
  const coarse = usePointerCoarse();
  const layout = mobile ? "unified" : preferredLayout;
  const collapsed = useFeedbackCollapsed();
  const [sheet, setSheet] = useState<MobileSheetState>("closed");
  const [commenting, setCommenting] = useState(false);
  const [notice, setNotice] = useState("");
  const [floating, setFloating] = useState<AnchorRect | null>(null);
  const [quote, setQuote] = useState<QuotePos | null>(null);
  const [jump, setJump] = useState<ArtifactCodeJump | null>(null);
  const [renderedJump, setRenderedJump] = useState<ArtifactRenderedPaneProps["jump"]>(null);
  const [summaryJump, setSummaryJump] = useState<{ target: ArtifactTarget; nonce: number } | null>(
    null,
  );
  const [fold, setFold] = useState<FoldSignal | null>(null);
  const [activePath, setActivePath] = useState<string | null>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  const suspendedSpy = useRef(false);
  const jumpNonce = useRef(0);
  const initialFeedback = useRef(view.feedbackId);
  const hasDraft = useHasArtifactDraft(detail.id);
  const hasNote = useHasArtifactNote(detail.id);
  const {
    version,
    latest,
    theme,
    viewed,
    filesQuery,
    diffQuery,
    sourceQuery,
    paths,
    path,
    file,
    canRender,
    context,
    regions,
    renderedTargets,
    viewedPaths,
    rounds,
    fetchContext,
  } = useArtifactContent(detail, view, setNotice);
  const virtual = useVirtualPaneController();
  const progressive = useProgressiveFileController();
  const resize = useResizableWidth("r3-feedback-width", {
    min: 300,
    max: 700,
    initial: 400,
    containerRef: splitRef,
  });
  useEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar) return;
    const resize = new ResizeObserver(() =>
      paneRef.current?.style.setProperty("--pane-sticky-h", `${toolbar.offsetHeight}px`),
    );
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
    const restore = () => setView(readArtifactLocation(detail.kind, location.search));
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [detail.kind]);

  useEffect(() => {
    onLocationChange?.({ ...view, path, versionSeq: version?.seq ?? view.versionSeq });
  }, [view, path, version?.seq, onLocationChange]);

  const changeView = useCallback((patch: Partial<ArtifactLocation>) => {
    setView((current) => ({ ...current, ...patch }));
    setJump(null);
    setRenderedJump(null);
    setSummaryJump(null);
    setNotice("");
  }, []);
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
        if (target.kind === "rendered") setRenderedJump({ locator: target.locator, nonce });
        else {
          setJump({
            path: target.path,
            start: target.locator?.start,
            end: target.locator?.end,
            side: target.kind === "diff" ? (target.locator?.side ?? "new") : "new",
            nonce,
          });
          setFold({ mode: "unfold", path: target.path, nonce });
        }
      } else setSummaryJump({ target, nonce });
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
      else setFeedbackCollapsed(false);
    },
    [mobile],
  );
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
  const ready =
    view.representation === "diff"
      ? !!diffQuery.data
      : view.representation === "source" && !!sourceQuery.data;
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
    ready: ready && detail.kind === "diff",
    fileList: paths,
  });
  useEffect(() => {
    if (!summaryJump) return;
    const target = summaryJump.target;
    if (target.kind !== "artifact_summary" && target.kind !== "version_summary") {
      paneRef.current?.scrollTo({ top: 0 });
      return;
    }
    const node = paneRef.current?.querySelector(
      `[data-artifact-summary="${target.kind === "artifact_summary" ? "artifact" : target.versionSeq}"]`,
    );
    node?.scrollIntoView({ block: "start" });
    const range = node && target.locator ? rangeForQuote(node, target.locator.quote) : null;
    setHighlightRanges(HL_ACTIVE, range ? [range] : []);
    return () => setHighlightRanges(HL_ACTIVE, []);
  }, [summaryJump]);

  const download = useMutation({
    mutationFn: async () => {
      if (!version || !path) return;
      const response = await artifactApi.download(detail.id, version.seq, path);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = path.split("/").at(-1)!;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    },
  });
  const currentPath = detail.kind === "diff" ? (activePath ?? paths[0]) : path;
  const wholeFile = () => {
    if (version && currentPath)
      anchor({
        kind: view.representation,
        versionSeq: version.seq,
        path: currentPath,
        locator: null,
      });
  };
  const toggleViewed = () => {
    if (detail.kind === "diff" && version && currentPath)
      viewed.toggle(diffViewedKey(version.seq, currentPath));
    else if (file) viewed.toggle(fileViewedKey(file.path, file.hash));
  };
  const stepFile = (direction: -1 | 1) => {
    const at = paths.indexOf(currentPath ?? "");
    const next = paths[Math.max(0, Math.min(paths.length - 1, at + direction))];
    if (next) selectFile(next);
  };
  useKeyBindings({
    generalNote: () => {
      anchor({ kind: "artifact" });
    },
    panelToggle: () => {
      if (mobile) setSheet(sheet === "closed" ? "full" : "closed");
      else setFeedbackCollapsed(!collapsed);
    },
    ...(version
      ? {
          versionNext: () =>
            changeView({ versionSeq: stepArtifactVersion(detail.versions, version.seq, 1) }),
          versionPrev: () =>
            changeView({ versionSeq: stepArtifactVersion(detail.versions, version.seq, -1) }),
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
          foldAll: () => setFold({ mode: "toggle", nonce: ++jumpNonce.current }),
        }
      : {}),
    ...(detail.kind === "diff" && !mobile
      ? { layoutToggle: () => setDiffLayout(layout === "split" ? "unified" : "split") }
      : {}),
  });

  const toolbar = (
    <div
      ref={toolbarRef}
      className="sticky top-0 z-20 flex flex-wrap items-center gap-2 border-b border-neutral-300 bg-white px-3 py-1 dark:border-neutral-700 dark:bg-neutral-950"
    >
      <ArtifactVersionSelect
        versions={detail.versions}
        selected={view.versionSeq}
        onChange={(versionSeq) => changeView({ versionSeq })}
      />
      {detail.kind !== "html" && (
        <JumpToFile
          files={paths}
          viewed={viewedPaths}
          activePath={currentPath}
          onSelect={selectFile}
          btnClassName="rounded p-1 text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
        />
      )}
      {detail.kind === "files" && (
        <div className="flex gap-1">
          <Button
            variant={view.representation === "source" ? "default" : "ghost"}
            aria-pressed={view.representation === "source"}
            onClick={() => changeView({ representation: "source" })}
          >
            Source
          </Button>
          <Button
            variant={view.representation === "rendered" ? "default" : "ghost"}
            aria-pressed={view.representation === "rendered"}
            disabled={!canRender}
            onClick={() => changeView({ representation: "rendered" })}
          >
            Rendered
          </Button>
        </div>
      )}
      {detail.kind === "diff" && (
        <Button
          className="max-md:hidden"
          onClick={() => setDiffLayout(layout === "split" ? "unified" : "split")}
        >
          {layout === "split" ? "Side by side" : "Unified"}
        </Button>
      )}
      {view.representation === "rendered" && (
        <Button
          variant={commenting ? "primary" : "default"}
          aria-pressed={commenting}
          onClick={() => setCommenting(!commenting)}
        >
          {commenting ? "Exit comment mode" : "Comment mode"}
        </Button>
      )}
      {detail.kind === "files" && file && (
        <Button disabled={download.isPending} onClick={() => download.mutate()}>
          Download
        </Button>
      )}
      {latest && version && latest.seq !== version.seq && (
        <Button variant="primary" onClick={() => changeView({ versionSeq: latest.seq })}>
          Open latest · {latest.seq}
        </Button>
      )}
    </div>
  );
  const failure =
    (detail.kind === "diff" ? diffQuery.error : filesQuery.error) ??
    (view.representation === "source" ? sourceQuery.error : null) ??
    download.error ??
    viewed.error;
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
      onCollapse={mobile ? undefined : () => setFeedbackCollapsed(true)}
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
      <div ref={splitRef} className="flex min-h-0 flex-1">
        {!mobile && detail.kind !== "html" && (
          <FileBrowser
            files={paths}
            viewed={viewedPaths}
            activePath={currentPath}
            onSelect={selectFile}
          />
        )}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: row highlighting is an extra pointer shortcut; every thread has a keyboard-accessible Locate control. */}
        <div
          ref={paneRef}
          className={cn(
            "min-h-0 min-w-0 flex-1 overflow-y-auto",
            !mobile && "[contain:paint]",
            view.representation === "rendered" && "flex flex-col [&>*]:shrink-0",
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
          <ArtifactHeader detail={detail} onDeleted={() => navigate("/")} />
          <ArtifactSummary
            source={detail.summary}
            onTarget={anchor}
            onJumpRef={(ref) => jumpRef(ref, context)}
          />
          {toolbar}
          {version && (
            <ArtifactSummary
              source={version.summary}
              versionSeq={version.seq}
              onTarget={anchor}
              onJumpRef={(ref) => jumpRef(ref, context)}
            />
          )}
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
          ) : view.representation === "rendered" ? (
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
                  if (next !== path) setRenderedJump(null);
                  setView((current) =>
                    current.path === next ? current : { ...current, path: next },
                  );
                },
                onFeedback: showFeedback,
              })
            ) : (
              <p className="p-6 text-sm text-neutral-500">
                {filesQuery.isPending
                  ? "Loading published document…"
                  : "This file has no rendered document in the selected version."}
              </p>
            )
          ) : (
            <VirtualPaneProvider scrollRef={paneRef} registry={virtual.registry}>
              <ProgressiveFileProvider
                scrollRef={paneRef}
                registry={progressive.registry}
                enabled={detail.kind === "diff" && paths.length >= 24}
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
                ) : file ? (
                  <FileCard
                    key={`${version.seq}:${file.path}`}
                    path={file.path}
                    viewed={viewed.isViewed(fileViewedKey(file.path, file.hash))}
                    onToggleViewed={() => viewed.toggle(fileViewedKey(file.path, file.hash))}
                    onFileFeedback={wholeFile}
                    foldSignal={fold}
                  >
                    {artifactMediaKind(file.mediaType) ? (
                      renderPreview({
                        detail,
                        version,
                        path: file.path,
                        commenting: false,
                        jump: null,
                        targets: [],
                        onTarget: anchor,
                        onDocument: () => {},
                        onFeedback: showFeedback,
                      })
                    ) : sourceQuery.isPending ? (
                      <p className="p-4 text-sm text-neutral-500">Loading published source…</p>
                    ) : sourceQuery.data?.kind === "text" ? (
                      <SourceCode
                        data={sourceQuery.data}
                        path={file.path}
                        onPickLines={(side, start, end, quote) =>
                          pickLines(file.path, side, start, end, quote)
                        }
                        regions={regions}
                      />
                    ) : (
                      <p className="p-4 text-sm text-neutral-500">
                        {sourceQuery.data?.kind === "oversize"
                          ? "This file is too large for source highlighting."
                          : "This file contains binary content."}{" "}
                        Download the published file to open it.
                      </p>
                    )}
                  </FileCard>
                ) : (
                  <p className="p-6 text-sm text-neutral-500">
                    {filesQuery.isPending
                      ? "Loading published files…"
                      : "This path is absent from the selected version."}
                  </p>
                )}
              </ProgressiveFileProvider>
            </VirtualPaneProvider>
          )}
        </div>
        {!mobile && (
          <aside
            className={cn(
              "relative shrink-0 overflow-hidden border-l border-neutral-300 dark:border-neutral-700",
              !resize.dragging && "transition-[width] duration-200",
            )}
            style={{ width: collapsed ? 32 : resize.width }}
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
            {collapsed && (
              <button
                type="button"
                aria-label="Expand feedback"
                onClick={() => setFeedbackCollapsed(false)}
                className="absolute inset-0 flex w-8 flex-col items-center gap-3 bg-white py-3 text-xs text-neutral-500 dark:bg-neutral-950"
              >
                <FoldChevrons dir="left" />
                <span className="[writing-mode:vertical-rl]">
                  FEEDBACK ·{" "}
                  {detail.feedback.filter((feedback) => feedback.status === "open").length}
                </span>
                {hasDraft && <span title="Unsaved draft">✎</span>}
                {detail.feedback.some(hasUnsentArtifactFeedback) && (
                  <span title="Feedback waiting to be sent">↥</span>
                )}
                {detail.watching && <span title="Agent listening">●</span>}
              </button>
            )}
          </aside>
        )}
      </div>
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
