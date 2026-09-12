import type { ArtifactPreviewNetwork } from "../../shared/artifacts.ts";
import type {
  PreviewCaptureState,
  PreviewDevicePermissions,
} from "../../shared/preview-protocol.ts";
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
    return { state: "sharing", label: "Camera or microphone sharing" } as const;
  if (
    previews.some(
      (preview) => preview.verification === "error" || preview.capture.phase === "error",
    )
  )
    return { state: "error", label: "Preview or device error" } as const;
  if (previews.some((preview) => preview.capture.phase === "requesting"))
    return { state: "limited", label: "Waiting for browser device permission" } as const;
  if (previews.some((preview) => preview.network === "external"))
    return { state: "limited", label: "External connections allowed" } as const;
  if (previews.some((preview) => preview.network === "compatible"))
    return { state: "limited", label: "Limited network protection" } as const;
  if (previews.some((preview) => preview.devices.camera || preview.devices.microphone))
    return { state: "limited", label: "Camera or microphone allowed" } as const;
  if (!previews.length || previews.some((preview) => preview.verification !== "ready"))
    return { state: "checking", label: "Checking preview protection" } as const;
  return { state: "verified", label: "External connections blocked; r3 isolated" } as const;
}
