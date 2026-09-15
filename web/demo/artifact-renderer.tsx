import { useEffect, useRef, useState } from "react";
import { MAX_RENDERED_HEIGHT } from "../../shared/artifacts.ts";
import type { PreviewDisplay } from "../../shared/preview-protocol.ts";
import { ArtifactLoading } from "../src/components/ArtifactLoading.tsx";
import { useDarkTheme } from "../src/hooks.ts";
import { keysSuspended } from "../src/keys.ts";
import type { ArtifactRenderedPaneProps, ArtifactRenderer } from "../src/pages/ArtifactView.tsx";
import { previewLocator, previewSelectionPosition } from "../src/preview-bridge.ts";
import { observePreviewViewport } from "../src/preview-viewport.ts";
import { cn } from "../src/ui.tsx";
import { prepareDemoDocument } from "./preview-document.ts";
import { bundledPreview } from "./preview-fixtures.ts";

export const renderPublishedPreview: ArtifactRenderer = (props) => (
  <DemoArtifactPreview {...props} />
);

export function DemoArtifactPreview(props: ArtifactRenderedPaneProps) {
  return (
    <DemoDocument
      key={`${props.version.artifactId}/${props.version.seq}/${props.version.contentHash}`}
      {...props}
    />
  );
}

function DemoDocument(props: ArtifactRenderedPaneProps) {
  const dark = useDarkTheme();
  const current = useRef({ props, dark });
  current.current = { props, dark };
  const iframe = useRef<HTMLIFrameElement>(null);
  const connection = useRef<MessagePort | null>(null);
  const sendDisplay = useRef(() => {});
  const nextRoute = useRef("#");
  const [document, setDocument] = useState<{
    html: string;
    markdown: boolean;
    contextId: string;
  } | null>(null);
  const [height, setHeight] = useState<number>();
  const measured = useRef(false);
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const { seq } = props.version;
  const path = props.path;

  useEffect(() => {
    const contextId = crypto.randomUUID();
    let prepared: ReturnType<typeof prepareDemoDocument>;
    try {
      prepared = prepareDemoDocument(
        current.current.props.version,
        path,
        contextId,
        location.origin,
        nextRoute.current,
      );
    } catch (error) {
      setError(error instanceof Error ? error.message : "Demo preview unavailable");
      setDocument(null);
      return;
    }
    nextRoute.current = "#";
    setReady(false);
    setError("");
    setNotice("");
    setHeight(undefined);
    measured.current = false;
    const send = (message: Record<string, unknown>) =>
      connection.current?.postMessage({ ...message, contextId });
    const display = () => {
      const { props, dark } = current.current;
      const fitContent = props.detail.kind === "files" && prepared.markdown;
      const value: PreviewDisplay = {
        theme: dark ? "dark" : "light",
        fitContent,
        commenting: props.commenting,
        noteHasText: props.noteHasText,
        composerVisible: props.composerVisible,
        targets: props.targets.flatMap(({ feedbackId, target }) =>
          target.kind === "rendered" && target.path === path && target.versionSeq === seq
            ? [{ feedbackId, locator: target.locator }]
            : [],
        ),
        jump: !fitContent || measured.current ? props.jump : null,
      };
      send({ type: "r3-preview-display", display: value });
    };
    sendDisplay.current = display;
    const listener = (event: MessageEvent) => {
      if (
        event.source !== iframe.current?.contentWindow ||
        event.origin !== "null" ||
        event.data?.type !== "r3-demo-preview-connect" ||
        event.data.contextId !== contextId ||
        event.data.path !== path ||
        event.ports.length !== 1 ||
        connection.current
      )
        return;
      const port = event.ports[0];
      connection.current = port;
      port.onmessage = (event) => {
        if (connection.current !== port) return;
        const message = event.data;
        if (!message || message.contextId !== contextId || message.path !== path) return;
        const { props } = current.current;
        if (message.type === "r3-preview-document") {
          setReady(true);
          display();
        } else if (message.type === "r3-preview-height") {
          if (
            props.detail.kind === "files" &&
            prepared.markdown &&
            typeof message.height === "number" &&
            Number.isFinite(message.height) &&
            message.height > 0 &&
            message.height <= MAX_RENDERED_HEIGHT
          )
            setHeight(Math.ceil(message.height));
        } else if (message.type === "r3-demo-preview-navigation") {
          if (
            typeof message.nextPath !== "string" ||
            typeof message.route !== "string" ||
            !message.route.startsWith("#") ||
            message.route.length > 2048 ||
            !bundledPreview(props.version, message.nextPath)
          )
            return;
          nextRoute.current = message.route;
          props.onDocument(message.nextPath);
        } else if (message.type === "r3-preview-target") {
          if (
            !props.commenting ||
            window.document.activeElement !== iframe.current ||
            keysSuspended()
          )
            return;
          try {
            props.onTarget({
              kind: "rendered",
              versionSeq: seq,
              path,
              locator: previewLocator(message.locator),
            });
          } catch {
            setNotice("Unable to capture this element.");
          }
        } else if (message.type === "r3-preview-selection") {
          if (
            window.document.activeElement !== iframe.current ||
            keysSuspended() ||
            !iframe.current
          )
            return;
          try {
            const locator = previewLocator(message.locator);
            if (!locator?.quote?.trim() || typeof message.quote !== "boolean") return;
            const frame = iframe.current.getBoundingClientRect();
            const pane =
              iframe.current.closest("[data-artifact-content]")?.getBoundingClientRect() ?? frame;
            const rect = previewSelectionPosition(message.rect, frame, {
              top: Math.max(0, frame.top, pane.top),
              right: Math.min(innerWidth, frame.right, pane.right),
              bottom: Math.min(innerHeight, frame.bottom, pane.bottom),
              left: Math.max(0, frame.left, pane.left),
            });
            props.onSelection?.(
              { kind: "rendered", versionSeq: seq, path, locator },
              rect,
              message.quote,
            );
          } catch {
            setNotice("Unable to capture this selection.");
          }
        } else if (message.type === "r3-preview-composer-key") {
          if (
            window.document.activeElement === iframe.current &&
            !keysSuspended() &&
            (message.action === "focus" || message.action === "escape")
          )
            props.onComposerKey?.(message.action);
        } else if (message.type === "r3-preview-feedback") {
          if (props.targets.some((target) => target.feedbackId === message.feedbackId))
            props.onFeedback(message.feedbackId);
        } else if (message.type === "r3-preview-located" && message.nonce === props.jump?.nonce) {
          setNotice(
            message.state === "ambiguous"
              ? "This target matches more than one place in the document."
              : message.state === "unplaced"
                ? "This target is unavailable in the current page state."
                : "",
          );
        }
      };
    };
    window.addEventListener("message", listener);
    setDocument({ ...prepared, contextId });
    return () => {
      window.removeEventListener("message", listener);
      connection.current?.close();
      connection.current = null;
      sendDisplay.current = () => {};
    };
  }, [seq, path]);

  useEffect(() => {
    measured.current = height !== undefined;
    if (ready) sendDisplay.current();
  });

  useEffect(() => {
    if (!ready || !document || !iframe.current) return;
    return observePreviewViewport(iframe.current, (viewport) =>
      connection.current?.postMessage({
        type: "r3-preview-viewport",
        contextId: document.contextId,
        viewport,
      }),
    );
  }, [ready, document]);

  return (
    <div
      className={cn(
        "relative flex flex-col bg-white dark:bg-neutral-950",
        height === undefined && "min-h-80 flex-1",
      )}
      aria-busy={!ready && !error}
    >
      <details className="shrink-0 border-b border-neutral-200 px-3 py-1 text-xs text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
        <summary className="cursor-pointer">Demo preview · bundled example</summary>
        <p className="py-2">
          This static demo renders only shipped samples in an opaque sandbox. Resource requests are
          restricted by CSP; the daemon’s verified network protection and device access are not
          simulated.
        </p>
      </details>
      {error ? (
        <p role="alert" className="p-6 text-sm">
          {error}
        </p>
      ) : (
        <>
          {notice && (
            <p
              role="status"
              className="border-b border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
            >
              {notice}
            </p>
          )}
          <div className={cn("relative flex flex-col", height === undefined && "min-h-80 flex-1")}>
            {!ready && <ArtifactLoading className="absolute inset-0 z-10" />}
            {document && (
              <iframe
                key={document.contextId}
                ref={iframe}
                srcDoc={document.html}
                title={`${props.detail.title || "Artifact"} demo preview`}
                sandbox="allow-scripts"
                allow="camera 'none'; microphone 'none'"
                referrerPolicy="no-referrer"
                aria-hidden={!ready}
                inert={!ready}
                style={{ height }}
                className={cn(
                  "w-full border-0",
                  height === undefined ? "min-h-80 flex-1" : "flex-none",
                  !ready && "invisible",
                )}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
}
