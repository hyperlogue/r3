import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { type ArtifactPreviewContext, artifactMediaKind } from "../../../shared/artifacts.ts";
import type { PreviewDisplay } from "../../../shared/preview-protocol.ts";
import { artifactApi } from "../artifact-api.ts";
import type { ArtifactRenderedPaneProps } from "../pages/ArtifactView.tsx";
import { previewBridgeCall, previewLocator } from "../preview-bridge.ts";
import { Button } from "../ui.tsx";

export function ArtifactPreview(props: ArtifactRenderedPaneProps) {
  const [attempt, retry] = useState(0);
  const files = useQuery({
    queryKey: ["artifact-files", props.detail.id, props.version.seq],
    queryFn: () => artifactApi.files(props.detail.id, props.version.seq),
    staleTime: Infinity,
  });
  const file = files.data?.find((file) => file.path === props.path);
  const media = !!file && !!artifactMediaKind(file.mediaType);
  return (
    <PreviewSession
      key={`${props.detail.id}:${props.version.seq}:${media ? props.path : "document"}:${attempt}`}
      {...props}
      paths={files.data?.map((file) => file.path) ?? []}
      onRetry={() => retry((value) => value + 1)}
    />
  );
}

function PreviewSession(
  props: ArtifactRenderedPaneProps & { paths: string[]; onRetry: () => void },
) {
  const qc = useQueryClient();
  const [initialPath] = useState(props.path);
  const [context, setContext] = useState<ArtifactPreviewContext | null>(null);
  const [src, setSrc] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  const iframe = useRef<HTMLIFrameElement>(null);
  const currentPath = useRef(initialPath);
  const verified = useRef(false);
  const current = useRef(props);
  current.current = props;
  const id = props.detail.id;
  const seq = props.version.seq;

  useEffect(() => {
    let closed = false;
    let grant: ArtifactPreviewContext | null = null;
    let timer: ReturnType<typeof setInterval>;
    setContext(null);
    setSrc("");
    setError("");
    setNotice("");
    setReady(false);
    verified.current = false;
    const renew = async () => {
      if (!grant || closed) return;
      try {
        grant = await artifactApi.renewPreview(grant.id);
      } catch (error) {
        if (!closed) {
          setError(error instanceof Error ? error.message : "Preview expired");
          setSrc("");
        }
      }
    };
    void artifactApi
      .createPreview(id, seq, initialPath)
      .then((value) => {
        grant = value;
        if (closed) {
          void artifactApi.revokePreview(value.id).catch(() => {});
          return;
        }
        setContext(value);
        setSrc(value.gateUrl);
        timer = setInterval(() => {
          void renew();
        }, 10 * 60_000);
      })
      .catch((error) => {
        if (!closed) setError(error instanceof Error ? error.message : "Preview unavailable");
      });
    const resume = () => {
      if (document.visibilityState === "visible") void renew();
    };
    document.addEventListener("visibilitychange", resume);
    return () => {
      closed = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
      if (grant) void artifactApi.revokePreview(grant.id).catch(() => {});
    };
  }, [id, seq, initialPath]);

  useEffect(() => {
    if (!context) return;
    let closed = false;
    let pending = 0;
    const seen = new Set<string>();
    const send = (value: Record<string, unknown>) =>
      iframe.current?.contentWindow?.postMessage(
        { contextId: context.id, ...value },
        context.origin,
      );
    const display = () => {
      const props = current.current;
      const value: PreviewDisplay = {
        commenting: props.commenting && context.presentation === "document",
        targets: props.targets.flatMap(({ feedbackId, target }) =>
          target.kind === "rendered" &&
          target.versionSeq === seq &&
          target.path === currentPath.current
            ? [{ feedbackId, locator: target.locator }]
            : [],
        ),
        jump: props.path === currentPath.current ? props.jump : null,
      };
      send({ type: "r3-preview-display", display: value });
    };
    const listener = (event: MessageEvent) => {
      if (event.source !== iframe.current?.contentWindow || event.origin !== context.origin) return;
      const message = event.data;
      if (!message || typeof message !== "object" || message.contextId !== context.id) return;
      if (message.type === "r3-preview-gate") {
        if (message.state === "ready" && !verified.current) {
          verified.current = true;
          setReady(false);
          setSrc(context.documentUrl);
        } else if (message.state === "unsupported" || message.state === "error") {
          setError(
            typeof message.message === "string"
              ? message.message.slice(0, 2048)
              : "Preview verification failed",
          );
        }
        return;
      }
      if (
        !verified.current ||
        typeof message.path !== "string" ||
        !current.current.paths.includes(message.path)
      )
        return;
      if (message.type === "r3-preview-document") {
        currentPath.current = message.path;
        current.current.onDocument(message.path);
        setReady(true);
        setNotice("");
        display();
      } else if (message.type === "r3-preview-target") {
        if (!current.current.commenting || context.presentation !== "document") return;
        try {
          const locator = previewLocator(message.locator);
          current.current.onTarget({
            kind: "rendered",
            versionSeq: seq,
            path: message.path,
            locator,
          });
        } catch (error) {
          setNotice(error instanceof Error ? error.message : "Unable to capture this element");
        }
      } else if (message.type === "r3-preview-feedback") {
        if (current.current.detail.feedback.some((feedback) => feedback.id === message.feedbackId))
          current.current.onFeedback(message.feedbackId);
      } else if (
        message.type === "r3-preview-located" &&
        message.nonce === current.current.jump?.nonce
      ) {
        setNotice(
          message.state === "ambiguous"
            ? "This target matches more than one place in the document."
            : message.state === "unplaced"
              ? "This target is unavailable in the current page state."
              : "",
        );
      } else if (
        message.type === "r3-preview-call" &&
        typeof message.id === "string" &&
        message.id.length <= 128 &&
        typeof message.method === "string"
      ) {
        if (seen.has(message.id)) return;
        if (pending >= 32) {
          send({
            type: "r3-preview-result",
            id: message.id,
            error: "Too many pending r3 requests",
          });
          return;
        }
        seen.add(message.id);
        if (seen.size > 512) seen.delete(seen.values().next().value!);
        pending++;
        const props = current.current;
        void previewBridgeCall(
          message.method,
          message.input,
          {
            artifactId: id,
            versionSeq: seq,
            path: message.path,
            resourceRoot: `${context.origin}/files/`,
            representation: context.presentation === "media" ? "source" : "rendered",
            state: props.detail.state,
          },
          props.detail,
          artifactApi,
          navigator.userActivation?.isActive === true,
        )
          .then((value) => {
            if (!closed) send({ type: "r3-preview-result", id: message.id, value });
            if (["createFeedback", "reply", "submit"].includes(message.method))
              void qc.invalidateQueries({ queryKey: ["artifact", id] });
          })
          .catch((error) => {
            if (!closed)
              send({
                type: "r3-preview-result",
                id: message.id,
                error: error instanceof Error ? error.message : "r3 request failed",
              });
          })
          .finally(() => {
            pending--;
          });
      }
    };
    window.addEventListener("message", listener);
    return () => {
      closed = true;
      window.removeEventListener("message", listener);
    };
  }, [context, id, seq, qc]);

  useEffect(() => {
    if (!context || !verified.current || !ready || props.path === currentPath.current) return;
    currentPath.current = props.path;
    setReady(false);
    setNotice("");
    setSrc(
      context.presentation === "media"
        ? context.documentUrl
        : `${context.origin}/files/${props.path.split("/").map(encodeURIComponent).join("/")}`,
    );
  }, [context, props.path, ready]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a changed thread or lifecycle snapshot must notify utility subscribers even when the displayed targets stay identical.
  useEffect(() => {
    if (!context || !ready) return;
    const send = (value: Record<string, unknown>) =>
      iframe.current?.contentWindow?.postMessage(
        { contextId: context.id, ...value },
        context.origin,
      );
    const display: PreviewDisplay = {
      commenting: props.commenting && context.presentation === "document",
      targets: props.targets.flatMap(({ feedbackId, target }) =>
        target.kind === "rendered" && target.versionSeq === seq && target.path === props.path
          ? [{ feedbackId, locator: target.locator }]
          : [],
      ),
      jump: props.jump,
    };
    send({ type: "r3-preview-display", display });
    send({ type: "r3-preview-changed" });
  }, [context, ready, seq, props.commenting, props.targets, props.jump, props.path, props.detail]);

  return (
    <div className="relative flex min-h-80 flex-1 flex-col bg-white" data-artifact-preview>
      {error ? (
        <div role="alert" className="p-6 text-sm text-neutral-700">
          <p>{error}</p>
          <Button className="mt-3" onClick={props.onRetry}>
            Retry preview
          </Button>
        </div>
      ) : !src ? (
        <p role="status" className="p-6 text-sm text-neutral-500">
          Opening published preview…
        </p>
      ) : null}
      {notice && (
        <p
          role="status"
          className="border-b border-amber-200 bg-amber-50 p-3 text-sm text-amber-800"
        >
          {notice}
        </p>
      )}
      {src && !error && (
        <iframe
          ref={iframe}
          src={src}
          title={`${props.detail.title || "Artifact"} preview`}
          sandbox="allow-scripts allow-same-origin allow-forms"
          allow="camera 'src'; microphone 'src'"
          referrerPolicy="no-referrer"
          className="min-h-80 w-full flex-1 border-0 bg-white"
        />
      )}
    </div>
  );
}
