import { useEffect, useId, useRef, useState } from "react";
import type { ArtifactPreviewNetwork } from "../../../shared/artifacts.ts";
import type {
  PreviewCaptureState,
  PreviewDevicePermissions,
} from "../../../shared/preview-protocol.ts";
import { suspendKeys } from "../keys.ts";
import type { PreviewVerification } from "../preview-protection.ts";
import { Button } from "../ui.tsx";
import { ArtifactPreviewProtection } from "./ArtifactPreviewProtection.tsx";

export function ArtifactPreviewNetworkControl({
  network,
  verification,
  html,
  compatibilityAccepted,
  onForgetCompatibility,
  devices,
  capture,
  onStopSharing,
  onChange,
}: {
  network: ArtifactPreviewNetwork;
  verification: PreviewVerification;
  html: boolean;
  compatibilityAccepted: boolean;
  onForgetCompatibility: () => void;
  devices: PreviewDevicePermissions;
  capture: PreviewCaptureState;
  onStopSharing: () => void;
  onChange: (network: ArtifactPreviewNetwork, devices: PreviewDevicePermissions) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const external = network === "external";
  return (
    <div
      data-preview-network={network}
      data-preview-camera={devices.camera ? "allowed" : "blocked"}
      data-preview-microphone={devices.microphone ? "allowed" : "blocked"}
      className="space-y-3 text-xs"
    >
      <ArtifactPreviewProtection
        network={network}
        verification={verification}
        devices={devices}
        capture={capture}
        compatibilityAccepted={compatibilityAccepted}
        onForgetCompatibility={onForgetCompatibility}
      />
      <div className="sr-only">
        <span role="status">
          {verification === "checking"
            ? "Checking preview protection…"
            : verification === "error"
              ? "Preview not running"
              : external
                ? "External connections allowed for this version"
                : network === "compatible"
                  ? "Limited network protection"
                  : "External connections blocked"}
        </span>
        {external && (devices.camera || devices.microphone) && (
          <span className="block text-neutral-600 dark:text-neutral-300">
            {[devices.camera && "Camera allowed", devices.microphone && "Microphone allowed"]
              .filter(Boolean)
              .join(" · ")}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {html && (
          <Button onClick={() => setConfirming(true)}>
            {external ? "Permissions" : "Allow external access"}
          </Button>
        )}
        {external && (
          <Button onClick={() => onChange("blocked", { camera: false, microphone: false })}>
            Restore protection
          </Button>
        )}
      </div>
      {capture.phase !== "idle" && (
        <div
          data-preview-capture={capture.phase}
          className="flex w-full flex-wrap items-center justify-between gap-2 border-t border-current/15 pt-1.5"
        >
          <span role="status">
            {capture.phase === "error"
              ? capture.message
              : capture.phase === "requesting"
                ? "Waiting for browser device permission…"
                : `Sharing ${[capture.camera && "camera", capture.microphone && "microphone"].filter(Boolean).join(" and ")}`}
          </span>
          {capture.phase !== "error" && (
            <Button onClick={onStopSharing}>
              {capture.phase === "requesting" ? "Cancel request" : "Stop sharing"}
            </Button>
          )}
        </div>
      )}
      {confirming && (
        <NetworkConsent
          devices={devices}
          external={external}
          onCancel={() => setConfirming(false)}
          onAllow={(devices) => {
            setConfirming(false);
            onChange("external", devices);
          }}
        />
      )}
    </div>
  );
}

function NetworkConsent({
  devices,
  external,
  onCancel,
  onAllow,
}: {
  devices: PreviewDevicePermissions;
  external: boolean;
  onCancel: () => void;
  onAllow: (devices: PreviewDevicePermissions) => void;
}) {
  const [selected, setSelected] = useState(devices);
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const description = useId();
  useEffect(() => {
    const node = dialog.current;
    const resumeKeys = suspendKeys();
    node?.showModal();
    return () => {
      node?.close();
      resumeKeys();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={title}
      aria-describedby={description}
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border border-neutral-300 bg-white p-5 text-neutral-900 r3-modal backdrop:bg-black/40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
    >
      <h2 id={title} className="text-base font-semibold">
        {external ? "Artifact permissions" : "Allow external access?"}
      </h2>
      <div
        id={description}
        className="mt-3 space-y-3 text-sm text-neutral-600 dark:text-neutral-300"
      >
        <p>
          This page and any external scripts it loads can send its published files, your input, and
          this artifact’s conversations to external services. Any shared camera or microphone data
          can also be sent elsewhere.
        </p>
        <p>
          r3 stays isolated. Only enable this for content you trust. The browser will still ask for
          device permission when needed.
        </p>
        <p>
          {external
            ? "Network access lasts for this version."
            : "The preview will reload with network access."}{" "}
          Device choices reset whenever the page navigates. All choices reset when you switch
          versions or leave the preview. Restoring protection cannot undo data already sent.
        </p>
      </div>
      <fieldset className="mt-4 border-t border-neutral-200 pt-2 text-sm dark:border-neutral-700">
        <legend className="font-medium">Also allow this page to request</legend>
        {(["camera", "microphone"] as const).map((kind) => (
          <label
            key={kind}
            className="flex min-h-11 cursor-pointer items-center gap-2 py-1 md:min-h-9"
          >
            <input
              type="checkbox"
              checked={selected[kind]}
              onChange={(event) => {
                const checked = event.currentTarget.checked;
                setSelected((value) => ({ ...value, [kind]: checked }));
              }}
            />
            {kind === "camera" ? "Camera" : "Microphone"}
          </label>
        ))}
      </fieldset>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button onClick={onCancel}>{external ? "Cancel" : "Keep protection"}</Button>
        <Button variant="primary" onClick={() => onAllow(selected)}>
          {external ? "Save permissions" : "Allow external access"}
        </Button>
      </div>
    </dialog>
  );
}
