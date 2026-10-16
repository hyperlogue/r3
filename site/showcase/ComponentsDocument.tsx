import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_RENDERED_HEIGHT } from "../../shared/artifacts.ts";
import type { PreviewBootstrap, PreviewDisplay } from "../../shared/preview-protocol.ts";
import type { ArtifactRenderedPaneProps } from "../../web/src/artifact-page.tsx";
import { keysSuspended } from "../../web/src/keys.ts";
import { previewLocator, previewSelectionPosition } from "../../web/src/preview-bridge.ts";
import { observePreviewViewport } from "../../web/src/preview-viewport.ts";
import { componentDocument } from "./component-document.ts";

// The authored sample runs separately; annotation visuals and interaction come
// directly from the product's preview runtime, with only local fixture actions.
export function ComponentsDocument(
  props: ArtifactRenderedPaneProps & {
    document?: (config: PreviewBootstrap) => string;
    title?: string;
  },
) {
  const fitContent = props.detail.kind === "files" && props.path.endsWith(".md");
  const [height, setHeight] = useState<number>();
  const measured = useRef(false);
  const iframe = useRef<HTMLIFrameElement>(null);
  const current = useRef(props);
  current.current = props;
  const connection = useRef<MessagePort | null>(null);
  const sendDisplay = useRef(() => {});
  const document = useMemo(() => {
    const contextId = crypto.randomUUID();
    return {
      contextId,
      html: (props.document ?? componentDocument)({
        contextId,
        applicationOrigin: location.origin,
        artifactId: props.version.artifactId,
        versionSeq: props.version.seq,
        entryPath: props.path,
        resourceRoot: "",
        presentation: "document",
      }),
    };
  }, [props.version.artifactId, props.version.seq, props.path, props.document]);

  useEffect(() => {
    setHeight(undefined);
    measured.current = false;
    let stopViewport: (() => void) | undefined;
    const { contextId } = document;
    const send = (message: Record<string, unknown>) =>
      connection.current?.postMessage({ ...message, contextId });
    const display = () => {
      const props = current.current;
      const value: PreviewDisplay = {
        fitContent,
        theme: window.document.documentElement.classList.contains("dark") ? "dark" : "light",
        commenting: props.active !== false && props.commenting,
        highlightLocated: props.highlightLocated,
        noteHasText: props.noteHasText,
        composerVisible: props.composerVisible,
        targets: props.targets.flatMap(({ threadId, target }) =>
          target.kind === "rendered" &&
          target.path === props.path &&
          target.versionSeq === props.version.seq
            ? [{ threadId, locator: target.locator }]
            : [],
        ),
        jump: !fitContent || measured.current ? props.jump : null,
      };
      send({ type: "r3-preview-display", display: value });
    };
    sendDisplay.current = display;
    const connect = (event: MessageEvent) => {
      if (
        event.source !== iframe.current?.contentWindow ||
        event.origin !== "null" ||
        event.data?.type !== "r3-demo-preview-connect" ||
        event.data.contextId !== contextId ||
        event.data.path !== current.current.path ||
        event.ports.length !== 1 ||
        connection.current
      )
        return;
      const port = event.ports[0];
      connection.current = port;
      port.onmessage = ({ data: message }) => {
        const props = current.current;
        if (
          connection.current !== port ||
          message?.contextId !== contextId ||
          message.path !== props.path
        )
          return;
        if (message.type === "r3-preview-document") {
          display();
        } else if (message.type === "r3-preview-height" && fitContent) {
          if (
            typeof message.height === "number" &&
            Number.isFinite(message.height) &&
            message.height > 0 &&
            message.height <= MAX_RENDERED_HEIGHT
          )
            setHeight(Math.ceil(message.height));
        } else if (message.type === "r3-preview-located" && message.nonce === props.jump?.nonce) {
          if (["anchored", "ambiguous", "unplaced"].includes(message.state))
            props.onLocated?.(message.state);
        } else if (props.active !== false) {
          if (
            message.type === "r3-preview-threads" &&
            props.targets.some(({ threadId }) => threadId === message.threadId)
          ) {
            props.onThread(message.threadId);
          } else if (window.document.activeElement === iframe.current && !keysSuspended()) {
            if (message.type === "r3-preview-target" && props.commenting) {
              props.onTarget({
                kind: "rendered",
                versionSeq: props.version.seq,
                path: props.path,
                locator: previewLocator(message.locator),
              });
            } else if (
              message.type === "r3-preview-selection" &&
              iframe.current &&
              typeof message.quote === "boolean"
            ) {
              const locator = previewLocator(message.locator);
              if (!locator?.quote?.trim()) return;
              const frame = iframe.current.getBoundingClientRect();
              const rect = previewSelectionPosition(message.rect, frame, frame);
              props.onSelection?.(
                { kind: "rendered", versionSeq: props.version.seq, path: props.path, locator },
                rect,
                message.quote,
              );
            } else if (
              message.type === "r3-preview-composer-key" &&
              ["focus", "escape"].includes(message.action)
            ) {
              props.onComposerKey?.(message.action);
            }
          }
        }
      };
      stopViewport = observePreviewViewport(iframe.current!, (viewport) =>
        send({ type: "r3-preview-viewport", viewport }),
      );
    };
    window.addEventListener("message", connect);
    return () => {
      window.removeEventListener("message", connect);
      stopViewport?.();
      connection.current?.close();
      connection.current = null;
      sendDisplay.current = () => {};
    };
  }, [document, fitContent]);
  useEffect(() => {
    if (height === undefined) return;
    measured.current = true;
    sendDisplay.current();
  }, [height]);
  useEffect(() => sendDisplay.current());
  return (
    <iframe
      key={document.contextId}
      ref={iframe}
      srcDoc={document.html}
      className="component-preview"
      style={fitContent ? { height: height ?? 600, flex: "none" } : undefined}
      title={props.title ?? "Component showcase document"}
      sandbox="allow-scripts"
      allow="camera 'none'; microphone 'none'"
      referrerPolicy="no-referrer"
      inert={props.active === false}
    />
  );
}
