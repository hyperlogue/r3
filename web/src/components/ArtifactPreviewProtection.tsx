import type { ReactNode } from "react";
import type { ArtifactPreviewNetwork } from "../../../shared/artifacts.ts";
import type {
  PreviewCaptureState,
  PreviewDevicePermissions,
} from "../../../shared/preview-protocol.ts";
import { t, useLocale } from "../i18n.ts";
import type { PreviewVerification } from "../preview-protection.ts";
import { Button, cn, StrokeIcon } from "../ui.tsx";

export function ArtifactPreviewProtection({
  network,
  verification,
  devices,
  capture,
  compatibilityAccepted,
  onForgetCompatibility,
}: {
  network: ArtifactPreviewNetwork;
  verification: PreviewVerification;
  devices: PreviewDevicePermissions;
  capture: PreviewCaptureState;
  compatibilityAccepted: boolean;
  onForgetCompatibility: () => void;
}) {
  useLocale();
  const ready = verification === "ready";
  const inactive =
    verification === "checking" ? t("Checking preview protection") : t("Preview not running");
  const items: {
    key: string;
    label: string;
    description: string;
    state: string;
    icon: ReactNode;
  }[] = [
    {
      key: "isolation",
      label: ready ? "r3 isolated" : inactive,
      description: t(
        "The artifact cannot directly access r3’s page, credentials, or unrelated artifacts. Its r3 bridge can access this artifact’s conversations.",
      ),
      state: ready ? "verified" : verification,
      icon: (
        <>
          <path d="M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7z" />
          {ready && <path d="m8 12 3 3 5-6" />}
        </>
      ),
    },
    {
      key: "network",
      label: !ready
        ? inactive
        : network === "blocked"
          ? t("External connections blocked")
          : network === "compatible"
            ? t("Limited network protection")
            : t("External connections allowed"),
      description:
        network === "blocked"
          ? t(
              "Verified network protection means this preview passed the browser’s network-blocking checks. It does not certify the artifact’s content.",
            )
          : network === "compatible"
            ? t(
                "You accepted limited protection, so browser checks are skipped until you forget that choice. Published documents restrict external resources; pages reached through navigation may have no network restrictions. Either may transmit files, conversations, or input.",
              )
            : t(
                "This page can load external scripts and contact external services. Published files, conversations, input, and shared media can be sent elsewhere.",
              ),
      state: !ready ? verification : network === "blocked" ? "verified" : "limited",
      icon: (
        <>
          <rect x="5" y="10" width="14" height="11" rx="2" />
          <path d={network === "blocked" ? "M8 10V7a4 4 0 0 1 8 0v3" : "M8 10V7a4 4 0 0 1 8 0"} />
          <path d="M12 14v3" />
        </>
      ),
    },
    ...(["camera", "microphone"] as const).map((kind) => {
      const name = kind === "camera" ? t("Camera") : t("Microphone");
      const sharing = capture.phase === "sharing" && capture[kind];
      return {
        key: kind,
        label: t(
          sharing ? "{device} sharing" : devices[kind] ? "{device} allowed" : "{device} blocked",
          { device: name },
        ),
        description: sharing
          ? t(
              "{name} is being shared with this page. Use Stop sharing to end capture and clear device consent.",
              { name: name },
            )
          : devices[kind]
            ? t("This page may request {kind}. Browser permission is also required.", {
                kind: t(kind === "camera" ? "camera" : "microphone"),
              })
            : t("This page has no r3 permission to use your {kind}.", {
                kind: t(kind === "camera" ? "camera" : "microphone"),
              }),
        state: sharing ? "sharing" : devices[kind] ? "limited" : "blocked",
        icon: (
          <>
            {kind === "camera" ? (
              <>
                <rect x="3" y="6" width="12" height="12" rx="2" />
                <path d="m15 10 6-4v12l-6-4" />
              </>
            ) : (
              <>
                <rect x="9" y="2" width="6" height="12" rx="3" />
                <path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" />
              </>
            )}
            {!devices[kind] && <path d="m2 2 20 20" />}
          </>
        ),
      };
    }),
  ];
  const color = (state: string) =>
    state === "verified"
      ? "text-emerald-700 dark:text-emerald-400"
      : state === "limited"
        ? "text-amber-700 dark:text-amber-400"
        : state === "sharing"
          ? "text-red-700 dark:text-red-400"
          : "text-neutral-500 dark:text-neutral-400";
  return (
    <div data-preview-protections>
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.key}>
            <p className={cn("flex items-center gap-2 font-medium", color(item.state))}>
              <span
                role="img"
                aria-label={item.label}
                data-preview-protection={item.key}
                data-state={item.state}
              >
                <StrokeIcon className="size-4">{item.icon}</StrokeIcon>
              </span>
              {item.label}
            </p>
            <p className="mt-1 text-xs text-neutral-600 dark:text-neutral-300">
              {item.description}
            </p>
          </li>
        ))}
      </ul>
      {compatibilityAccepted && (
        <Button className="mt-3" onClick={onForgetCompatibility}>
          {t("Forget browser choice")}
        </Button>
      )}
    </div>
  );
}
