import type { ArtifactPreviewNetwork } from "../../shared/artifacts.ts";
import type {
  PreviewCaptureState,
  PreviewDevicePermissions,
} from "../../shared/preview-protocol.ts";
import { t } from "./i18n.ts";
import type { PreviewVerification } from "./preview-protection.ts";

export interface PreviewSecurityState {
  network: ArtifactPreviewNetwork;
  verification: PreviewVerification;
  devices: PreviewDevicePermissions;
  capture: PreviewCaptureState;
}

// A workspace may render several files at once. Its single indicator must not
// present one protected preview as proof that every preview is protected.
export function previewSecuritySummary(previews: readonly PreviewSecurityState[]) {
  if (previews.some((preview) => preview.capture.phase === "sharing"))
    return { state: "sharing", label: t("previewSecurity.cameraOrMicrophoneSharing") } as const;
  if (
    previews.some(
      (preview) => preview.verification === "error" || preview.capture.phase === "error",
    )
  )
    return { state: "error", label: t("previewSecurity.previewOrDeviceError") } as const;
  if (previews.some((preview) => preview.capture.phase === "requesting"))
    return {
      state: "limited",
      label: t("previewSecurity.waitingForBrowserDevicePermission"),
    } as const;
  if (previews.some((preview) => preview.network === "external"))
    return { state: "limited", label: t("common.externalConnectionsAllowed") } as const;
  if (previews.some((preview) => preview.network === "compatible"))
    return { state: "limited", label: t("common.limitedNetworkProtection") } as const;
  if (previews.some((preview) => preview.devices.camera || preview.devices.microphone))
    return { state: "limited", label: t("previewSecurity.cameraOrMicrophoneAllowed") } as const;
  if (!previews.length || previews.some((preview) => preview.verification !== "ready"))
    return { state: "checking", label: t("common.checkingPreviewProtection") } as const;
  return {
    state: "verified",
    label: t("previewSecurity.externalConnectionsBlockedR3Isolated"),
  } as const;
}
