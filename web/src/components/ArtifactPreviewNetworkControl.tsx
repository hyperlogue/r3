import { useEffect, useId, useRef, useState } from "react";
import type { ArtifactPreviewNetwork } from "../../../shared/artifacts.ts";
import { suspendKeys } from "../keys.ts";
import { Button, cn } from "../ui.tsx";

export function ArtifactPreviewNetworkControl({
  network,
  onChange,
}: {
  network: ArtifactPreviewNetwork;
  onChange: (network: ArtifactPreviewNetwork) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const external = network === "external";
  return (
    <div
      data-preview-network={network}
      className={cn(
        "sticky top-[var(--pane-sticky-h,0px)] z-10 flex shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b px-3 py-1.5 text-xs",
        external
          ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-100"
          : "border-neutral-200 bg-neutral-50 text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-400",
      )}
    >
      <span role="status">
        {external
          ? "External connections allowed for this version"
          : "External connections blocked"}
      </span>
      <Button onClick={() => (external ? onChange("blocked") : setConfirming(true))}>
        {external ? "Block external connections" : "Allow external connections"}
      </Button>
      {confirming && (
        <NetworkConsent
          onCancel={() => setConfirming(false)}
          onAllow={() => {
            setConfirming(false);
            onChange("external");
          }}
        />
      )}
    </div>
  );
}

function NetworkConsent({ onCancel, onAllow }: { onCancel: () => void; onAllow: () => void }) {
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
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl border border-neutral-300 bg-white p-5 text-neutral-900 shadow-xl backdrop:bg-black/40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100"
    >
      <h2 id={title} className="text-base font-semibold">
        Allow external connections?
      </h2>
      <div
        id={description}
        className="mt-3 space-y-3 text-sm text-neutral-600 dark:text-neutral-300"
      >
        <p>
          This page and any external scripts it loads can send its published files, your input, and
          this artifact’s conversations to external services.
        </p>
        <p>
          r3 stays isolated. Camera and microphone remain blocked. Only enable this for content you
          trust.
        </p>
        <p>
          The preview will reload. This choice resets when you switch versions or leave the preview.
          Blocking connections again cannot undo data already sent.
        </p>
      </div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <Button onClick={onCancel}>Keep protection</Button>
        <Button variant="primary" onClick={onAllow}>
          Allow external connections
        </Button>
      </div>
    </dialog>
  );
}
