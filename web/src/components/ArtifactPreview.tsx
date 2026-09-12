import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import {
  type ArtifactPreviewContext,
  type ArtifactPreviewNetwork,
  artifactMediaKind,
} from "../../../shared/artifacts.ts";
import type {
  PreviewCaptureState,
  PreviewDevicePermissions,
  PreviewDisplay,
} from "../../../shared/preview-protocol.ts";
import { artifactApi } from "../artifact-api.ts";
import type { ArtifactRenderedPaneProps } from "../pages/ArtifactView.tsx";
import { previewBridgeCall, previewLocator } from "../preview-bridge.ts";
import { PreviewCapture } from "../preview-capture.ts";
import {
  type PreviewVerification,
  previewCompatibility,
  useCompatibilityConsent,
} from "../preview-protection.ts";
import { Button } from "../ui.tsx";
import { ArtifactPreviewCompatibilityConsent } from "./ArtifactPreviewCompatibilityConsent.tsx";
import { ArtifactPreviewNetworkControl } from "./ArtifactPreviewNetworkControl.tsx";
import { ArtifactPreviewSecuritySource } from "./ArtifactPreviewSecurity.tsx";

const NO_DEVICES: PreviewDevicePermissions = { camera: false, microphone: false };

export function ArtifactPreview(props: ArtifactRenderedPaneProps) {
  // External resources and devices belong to this version visit. The separate
  // browser compatibility acknowledgment is considered only after a failed gate.
  return <VersionPreview key={`${props.detail.id}:${props.version.seq}`} {...props} />;
}

function VersionPreview(props: ArtifactRenderedPaneProps) {
  const [attempt, retry] = useState(0);
  const [network, setNetwork] = useState<ArtifactPreviewNetwork>("blocked");
  const [verification, setVerification] = useState<PreviewVerification>("checking");
  const [compatibilityRequired, setCompatibilityRequired] = useState(false);
  const [confirmCompatibility, setConfirmCompatibility] = useState(false);
  const [warningOwner] = useState(() => ({}));
  const compatibilityAccepted = useCompatibilityConsent();
  useEffect(() => () => previewCompatibility.closeWarning(warningOwner), [warningOwner]);
  const closeCompatibilityWarning = () => {
    previewCompatibility.closeWarning(warningOwner);
    setConfirmCompatibility(false);
  };
  const [devices, setDevices] = useState(NO_DEVICES);
  const [deviceEpoch, setDeviceEpoch] = useState(0);
  const [captureState, setCaptureState] = useState<PreviewCaptureState>({
    phase: "idle",
    ...NO_DEVICES,
  });
  const [capture] = useState(
    () =>
      new PreviewCapture({
        onState: setCaptureState,
        onRevoked: () => {
          setDevices(NO_DEVICES);
          setDeviceEpoch((epoch) => epoch + 1);
        },
      }),
  );
  useEffect(() => {
    const close = () => capture.close();
    window.addEventListener("pagehide", close);
    return () => {
      window.removeEventListener("pagehide", close);
      close();
    };
  }, [capture]);
  const resetDevices = () => {
    capture.revoke();
    setDevices(NO_DEVICES);
    setDeviceEpoch((epoch) => epoch + 1);
  };
  const changeNetwork = (nextNetwork: ArtifactPreviewNetwork, nextDevices = NO_DEVICES) => {
    capture.revoke();
    if (network === "external" && nextNetwork === "external") capture.allow(nextDevices);
    setDevices(nextNetwork === "external" ? nextDevices : NO_DEVICES);
    if (network !== nextNetwork) setVerification("checking");
    setCompatibilityRequired(false);
    closeCompatibilityWarning();
    setNetwork(nextNetwork);
  };
  useEffect(() => {
    if (network !== "compatible" || compatibilityAccepted) return;
    // Forgetting consent stops compatible previews in this tab and other tabs.
    // A failed retry stays closed until the user opens the warning again.
    previewCompatibility.suppressWarning();
    setVerification("checking");
    setNetwork("blocked");
  }, [network, compatibilityAccepted]);
  useEffect(() => {
    if (network !== "blocked" || !compatibilityRequired || !compatibilityAccepted) return;
    // Another preview may have obtained the site-wide acknowledgment while
    // this warning was open. Only an already-failed network gate can use it.
    setConfirmCompatibility(false);
    previewCompatibility.closeWarning(warningOwner);
    setCompatibilityRequired(false);
    setVerification("checking");
    setNetwork("compatible");
  }, [network, compatibilityRequired, compatibilityAccepted, warningOwner]);
  const files = useQuery({
    queryKey: ["artifact-files", props.detail.id, props.version.seq],
    queryFn: () => artifactApi.files(props.detail.id, props.version.seq),
    staleTime: Infinity,
  });
  const file = files.data?.find((file) => file.path === props.path);
  const media = !!file && !!artifactMediaKind(file.mediaType);
  return (
    <div className="flex min-h-80 flex-1 flex-col" data-artifact-preview>
      <ArtifactPreviewSecuritySource
        path={props.path}
        network={network}
        verification={verification}
        devices={devices}
        capture={captureState}
      >
        <ArtifactPreviewNetworkControl
          key={deviceEpoch}
          network={network}
          verification={verification}
          html={props.detail.kind === "html"}
          compatibilityAccepted={compatibilityAccepted}
          onForgetCompatibility={previewCompatibility.forget}
          devices={devices}
          capture={captureState}
          onStopSharing={resetDevices}
          onChange={changeNetwork}
        />
      </ArtifactPreviewSecuritySource>
      {confirmCompatibility && (
        <ArtifactPreviewCompatibilityConsent
          onCancel={closeCompatibilityWarning}
          onContinue={() => {
            previewCompatibility.accept();
            changeNetwork("compatible");
          }}
        />
      )}
      <PreviewSession
        key={`${media ? props.path : "document"}:${network}:${attempt}`}
        {...props}
        network={network}
        devices={devices}
        capture={capture}
        capturing={captureState.phase === "requesting" || captureState.phase === "sharing"}
        onDevicesReset={resetDevices}
        onVerification={setVerification}
        onNetworkUnsupported={() => {
          if (previewCompatibility.accepted()) {
            changeNetwork("compatible");
          } else {
            setCompatibilityRequired(true);
            if (previewCompatibility.requestWarning(warningOwner)) {
              setConfirmCompatibility(true);
            }
          }
        }}
        onReviewCompatibility={
          compatibilityRequired
            ? () => {
                if (previewCompatibility.requestWarning(warningOwner, true))
                  setConfirmCompatibility(true);
              }
            : undefined
        }
        paths={files.data?.map((file) => file.path) ?? []}
        onRetry={() => {
          setVerification("checking");
          setCompatibilityRequired(false);
          retry((value) => value + 1);
        }}
      />
    </div>
  );
}

function PreviewSession(
  props: ArtifactRenderedPaneProps & {
    paths: string[];
    network: ArtifactPreviewNetwork;
    devices: PreviewDevicePermissions;
    capture: PreviewCapture;
    capturing: boolean;
    onDevicesReset: () => void;
    onVerification: (state: PreviewVerification) => void;
    onNetworkUnsupported: () => void;
    onReviewCompatibility?: () => void;
    onRetry: () => void;
  },
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
  const connection = useRef<MessagePort | null>(null);
  const checkDocument = useRef(() => {});
  const current = useRef(props);
  current.current = props;
  const id = props.detail.id;
  const seq = props.version.seq;
  const network = props.network;
  const capture = props.capture;

  useEffect(() => {
    let closed = false;
    let grant: ArtifactPreviewContext | null = null;
    let timer: ReturnType<typeof setInterval>;
    setContext(null);
    setSrc("");
    setError("");
    setNotice("");
    setReady(false);
    current.current.onVerification("checking");
    verified.current = false;
    const renew = async () => {
      if (!grant || closed) return;
      try {
        grant = await artifactApi.renewPreview(grant.id);
      } catch (error) {
        if (!closed) {
          capture.close();
          current.current.onDevicesReset();
          current.current.onVerification("error");
          setError(error instanceof Error ? error.message : "Preview expired");
          setSrc("");
        }
      }
    };
    void artifactApi
      .createPreview(id, seq, initialPath, network)
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
        if (!closed) {
          current.current.onVerification("error");
          setError(error instanceof Error ? error.message : "Preview unavailable");
        }
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
  }, [id, seq, initialPath, network, capture]);

  useEffect(() => {
    if (!context) return;
    let closed = false;
    let pending = 0;
    let connected = false;
    let check: { nonce: string; timer: ReturnType<typeof setTimeout> } | null = null;
    const clearCheck = () => {
      if (check) clearTimeout(check.timer);
      check = null;
    };
    checkDocument.current = () => {
      const { capturing, devices } = current.current;
      if (!capturing && !devices.camera && !devices.microphone) return;
      if (check) return;
      const port = connection.current;
      if (!port) {
        if (connected) current.current.onDevicesReset();
        return;
      }
      const nonce = crypto.randomUUID();
      check = {
        nonce,
        timer: setTimeout(() => {
          if (connection.current !== port) return;
          capture.close();
          current.current.onDevicesReset();
          current.current.onVerification("error");
          port.close();
          connection.current = null;
          setError("Preview stopped responding. Retry to reconnect.");
          setSrc("");
        }, 1000),
      };
      // Only the currently displayed document receives the challenge. Its
      // response must return on the already-bound port before consent survives.
      iframe.current?.contentWindow?.postMessage({ type: "r3-preview-document-check", nonce }, "*");
    };
    const seen = new Set<string>();
    const send = (value: Record<string, unknown>) =>
      connection.current?.postMessage({ contextId: context.id, ...value });
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
      if (event.source !== iframe.current?.contentWindow || event.origin !== "null") return;
      const message = event.data;
      if (!message || typeof message !== "object" || message.contextId !== context.id) return;
      if (message.type === "r3-preview-gate") {
        // After the trusted gate finishes, publisher code knows the context id.
        // It must never forge a failure to downgrade policy or solicit consent.
        if (verified.current) return;
        if (message.state === "ready" && !verified.current) {
          verified.current = true;
          current.current.onVerification("ready");
          setReady(false);
          setSrc(context.documentUrl);
        } else if (message.state === "unsupported" || message.state === "error") {
          capture.close();
          current.current.onDevicesReset();
          current.current.onVerification("error");
          setError(
            typeof message.message === "string"
              ? message.message.slice(0, 2048)
              : "Preview verification failed",
          );
          if (
            message.state === "unsupported" &&
            message.reason === "network" &&
            network === "blocked"
          )
            current.current.onNetworkUnsupported();
        }
        return;
      }
      if (message.type !== "r3-preview-connect" || event.ports.length !== 1) return;
      if (
        !verified.current ||
        typeof message.path !== "string" ||
        !current.current.paths.includes(message.path)
      )
        return;
      clearCheck();
      connection.current?.close();
      const port = event.ports[0];
      connection.current = port;
      const path = message.path;
      const initiallyAllowed =
        !connected &&
        network === "external" &&
        context.network === "external" &&
        current.current.detail.kind === "html";
      if (connected) current.current.onDevicesReset();
      connected = true;
      const receiveCapture = capture.bind(
        (value) => port.postMessage({ contextId: context.id, ...value }),
        initiallyAllowed ? current.current.devices : NO_DEVICES,
      );
      port.onmessage = (event) => {
        if (closed || connection.current !== port) return;
        const message = event.data;
        if (!message || message.contextId !== context.id || message.path !== path) return;
        const reply = (value: Record<string, unknown>) =>
          port.postMessage({ contextId: context.id, ...value });
        if (message.type === "r3-preview-document-checked") {
          if (message.nonce === check?.nonce) clearCheck();
        } else if (message.type === "r3-preview-capture") {
          receiveCapture(message);
        } else if (message.type === "r3-preview-disconnect") {
          clearCheck();
          capture.close();
          current.current.onDevicesReset();
          port.close();
          connection.current = null;
        } else if (message.type === "r3-preview-document") {
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
          if (
            current.current.detail.feedback.some((feedback) => feedback.id === message.feedbackId)
          )
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
              resourceRoot: context.resourceRoot,
              representation: context.presentation === "media" ? "source" : "rendered",
              state: props.detail.state,
            },
            props.detail,
            artifactApi,
            navigator.userActivation?.isActive === true,
          )
            .then((value) => {
              if (!closed) reply({ type: "r3-preview-result", id: message.id, value });
              if (["createFeedback", "reply", "submit"].includes(message.method))
                void qc.invalidateQueries({ queryKey: ["artifact", id] });
            })
            .catch((error) => {
              if (!closed)
                reply({
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
    };
    window.addEventListener("message", listener);
    return () => {
      closed = true;
      clearCheck();
      checkDocument.current = () => {};
      connection.current?.close();
      connection.current = null;
      capture.close();
      window.removeEventListener("message", listener);
    };
  }, [context, id, seq, qc, capture, network]);

  useEffect(() => {
    if (!context || !verified.current || !ready || props.path === currentPath.current) return;
    currentPath.current = props.path;
    capture.revoke();
    current.current.onDevicesReset();
    setReady(false);
    setNotice("");
    setSrc(
      context.presentation === "media"
        ? context.documentUrl
        : `${context.resourceRoot}${props.path.split("/").map(encodeURIComponent).join("/")}`,
    );
  }, [context, props.path, ready, capture]);

  useEffect(() => {
    if (!props.capturing) return;
    // Covers a replacement whose load never finishes and an unresponsive page.
    const timer = setInterval(() => checkDocument.current(), 2000);
    return () => clearInterval(timer);
  }, [props.capturing]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: a changed thread or lifecycle snapshot must notify utility subscribers even when the displayed targets stay identical.
  useEffect(() => {
    if (!context || !ready) return;
    const send = (value: Record<string, unknown>) =>
      connection.current?.postMessage({ contextId: context.id, ...value });
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
    <div className="relative flex min-h-80 flex-1 flex-col bg-white">
      {error ? (
        <div role="alert" className="p-6 text-sm text-neutral-700">
          <p>{error}</p>
          <Button className="mt-3" onClick={props.onRetry}>
            Retry preview
          </Button>
          {props.onReviewCompatibility && (
            <Button className="ml-2 mt-3" onClick={props.onReviewCompatibility}>
              Review browser risk
            </Button>
          )}
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
          sandbox="allow-scripts"
          {...{ credentialless: "" }}
          allow="camera 'none'; microphone 'none'"
          referrerPolicy="no-referrer"
          // Verify the current port after every load. A count of gate/document
          // loads is unreliable when a page redirects before finishing loading.
          onLoad={() => checkDocument.current()}
          className="min-h-80 w-full flex-1 border-0 bg-white"
        />
      )}
    </div>
  );
}
