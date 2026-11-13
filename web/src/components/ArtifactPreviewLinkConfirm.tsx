import { useId, useLayoutEffect, useRef } from "react";
import { useTranslation } from "../i18n.ts";
import { suspendKeys } from "../keys.ts";
import { Button } from "../ui.tsx";

export function ArtifactPreviewLinkConfirm({
  href,
  onCancel,
  onOpen,
}: {
  href: string;
  onCancel: () => void;
  onOpen: () => void;
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
      data-preview-link-confirm
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
        {t("previewLink.title")}
      </h2>
      <p
        data-preview-link-href
        className="mt-3 max-h-40 overflow-auto rounded-md bg-neutral-100 px-2 py-1.5 font-mono text-xs break-all text-neutral-800 dark:bg-neutral-800 dark:text-neutral-200"
      >
        {href}
      </p>
      <p id={description} className="mt-3 text-sm text-neutral-600 dark:text-neutral-300">
        {t("previewLink.explanation")}
      </p>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button autoFocus onClick={onCancel}>
          {t("previewLink.cancel")}
        </Button>
        <Button variant="primary" data-preview-link-open onClick={onOpen}>
          {t("previewLink.open")}
        </Button>
      </div>
    </dialog>
  );
}
