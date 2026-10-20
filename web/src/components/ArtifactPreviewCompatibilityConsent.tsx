import { useId, useLayoutEffect, useRef } from "react";
import { useTranslation } from "../i18n.ts";
import { suspendKeys } from "../keys.ts";
import { Button } from "../ui.tsx";

export function ArtifactPreviewCompatibilityConsent({
  onCancel,
  onContinue,
}: {
  onCancel: () => void;
  onContinue: () => void;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const title = useId();
  const description = useId();
  useLayoutEffect(() => {
    const node = dialog.current;
    const resume = suspendKeys();
    node?.showModal();
    return () => {
      node?.close();
      resume();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      data-preview-compatibility-consent
      aria-labelledby={title}
      aria-describedby={description}
      onKeyDown={(event) => event.stopPropagation()}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-md overflow-auto rounded-xl border border-neutral-300 bg-white p-5 text-neutral-900 r3-modal backdrop:bg-black/40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
    >
      <h2 id={title} className="text-base font-semibold">
        {t("previewCompatibilityConsent.openPreviewsWithLimitedNetworkProtection")}
      </h2>
      <div
        id={description}
        className="mt-3 space-y-3 text-sm text-neutral-600 dark:text-neutral-300"
      >
        <p>{t("previewCompatibilityConsent.thisBrowserCannotEnforceCompleteBlockingOf")}</p>
        <p>{t("previewCompatibilityConsent.forExampleAChartLibraryCopiedInto")}</p>
        <p>{t("previewCompatibilityConsent.theArtifactStaysIsolatedFromR3S")}</p>
        <p>{t("previewCompatibilityConsent.continueOnlyWithContentYouTrustThis")}</p>
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button onClick={onCancel}>{t("previewCompatibilityConsent.keepPreviewClosed")}</Button>
        <Button variant="primary" onClick={onContinue}>
          {t("previewCompatibilityConsent.acceptRiskAndContinue")}
        </Button>
      </div>
    </dialog>
  );
}
