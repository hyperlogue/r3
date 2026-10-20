import { useId, useLayoutEffect, useRef, useState } from "react";
import type { ArtifactPreviewNetwork } from "../../../shared/artifacts.ts";
import type {
  PreviewCaptureState,
  PreviewDevicePermissions,
} from "../../../shared/preview-protocol.ts";
import { useTranslation } from "../i18n.ts";
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
  const { t } = useTranslation();
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
            ? t("previewNetworkControl.checkingPreviewProtection")
            : verification === "error"
              ? t("common.previewNotRunning")
              : external
                ? t("previewNetworkControl.externalConnectionsAllowedForThisVersion")
                : network === "compatible"
                  ? t("common.limitedNetworkProtection")
                  : t("common.externalConnectionsBlocked")}
        </span>
        {external && (devices.camera || devices.microphone) && (
          <span className="block text-neutral-600 dark:text-neutral-300">
            {[
              devices.camera && t("previewNetworkControl.cameraAllowed"),
              devices.microphone && t("previewNetworkControl.microphoneAllowed"),
            ]
              .filter(Boolean)
              .join(" · ")}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-1">
        {html && (
          <Button onClick={() => setConfirming(true)}>
            {external
              ? t("previewNetworkControl.permissions")
              : t("previewNetworkControl.allowExternalAccess")}
          </Button>
        )}
        {external && (
          <Button onClick={() => onChange("blocked", { camera: false, microphone: false })}>
            {t("previewNetworkControl.restoreProtection")}
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
                ? t("previewNetworkControl.waitingForBrowserDevicePermission")
                : t(
                    capture.camera && capture.microphone
                      ? "previewNetworkControl.sharingCameraAndMicrophone"
                      : capture.camera
                        ? "previewNetworkControl.sharingCamera"
                        : "previewNetworkControl.sharingMicrophone",
                  )}
          </span>
          {capture.phase !== "error" && (
            <Button onClick={onStopSharing}>
              {capture.phase === "requesting"
                ? t("previewNetworkControl.cancelRequest")
                : t("previewNetworkControl.stopSharing")}
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
  const { t } = useTranslation();
  const [selected, setSelected] = useState(devices);
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const description = useId();
  useLayoutEffect(() => {
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
        {external
          ? t("previewNetworkControl.artifactPermissions")
          : t("previewNetworkControl.allowExternalAccess2")}
      </h2>
      <div
        id={description}
        className="mt-3 space-y-3 text-sm text-neutral-600 dark:text-neutral-300"
      >
        <p>{t("previewNetworkControl.thisPageAndAnyExternalScriptsIt")}</p>
        <p>{t("previewNetworkControl.r3StaysIsolatedOnlyEnableThisFor")}</p>
        <p>
          {t("common.deviceChoicesResetWheneverThePageNavigates", {
            external_t_Network_access_lasts_for_this: external
              ? t("previewNetworkControl.networkAccessLastsForThisVersion")
              : t("previewNetworkControl.thePreviewWillReloadWithNetworkAccess"),
          })}
        </p>
      </div>
      <fieldset className="mt-4 border-t border-neutral-200 pt-2 text-sm dark:border-neutral-700">
        <legend className="font-medium">
          {t("previewNetworkControl.alsoAllowThisPageToRequest")}
        </legend>
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
            {kind === "camera" ? t("common.camera") : t("common.microphone")}
          </label>
        ))}
      </fieldset>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button onClick={onCancel}>
          {external ? t("common.cancel") : t("previewNetworkControl.keepProtection")}
        </Button>
        <Button variant="primary" onClick={() => onAllow(selected)}>
          {external
            ? t("previewNetworkControl.savePermissions")
            : t("previewNetworkControl.allowExternalAccess")}
        </Button>
      </div>
    </dialog>
  );
}
