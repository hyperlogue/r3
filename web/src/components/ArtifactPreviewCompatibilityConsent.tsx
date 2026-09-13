import { useId, useLayoutEffect, useRef } from "react";
import { suspendKeys } from "../keys.ts";
import { Button } from "../ui.tsx";

export function ArtifactPreviewCompatibilityConsent({
  onCancel,
  onContinue,
}: {
  onCancel: () => void;
  onContinue: () => void;
}) {
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
        Open previews with limited network protection?
      </h2>
      <div
        id={description}
        className="mt-3 space-y-3 text-sm text-neutral-600 dark:text-neutral-300"
      >
        <p>
          This browser cannot enforce complete blocking of external connections. Published pages
          restrict ordinary external resources, but a malicious script could send data through
          navigation or other browser features. A page reached through navigation may have no
          network restrictions.
        </p>
        <p>
          For example, a chart library copied into an artifact could send its published files, this
          artifact’s conversations, or information you enter to another server.
        </p>
        <p>
          The artifact stays isolated from r3’s credentials and unrelated artifacts. Camera and
          microphone stay blocked unless you separately allow sharing.
        </p>
        <p>
          Continue only with content you trust. This choice is remembered for previews on this r3
          site in this browser. You can forget it in the protection icons above the preview.
          Browsers that pass the protection check always use full network blocking.
        </p>
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button onClick={onCancel}>Keep preview closed</Button>
        <Button variant="primary" onClick={onContinue}>
          Accept risk and continue
        </Button>
      </div>
    </dialog>
  );
}
