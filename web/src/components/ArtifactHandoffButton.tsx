import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { copyText } from "../clipboard.ts";
import { Button, StrokeIcon, useCopyFlash, useEscape, usePopoverFocus } from "../ui.tsx";
import type { useArtifactHandoff } from "../useArtifactHandoff.ts";

export function ArtifactHandoffButton({
  handoff,
  active = true,
}: {
  handoff: ReturnType<typeof useArtifactHandoff>;
  active?: boolean;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();
  useEffect(() => {
    if (!active || handoff.watchers.length || handoff.disabledReason) setOpen(false);
  }, [active, handoff.watchers.length, handoff.disabledReason]);
  const showCommand = active && open && !handoff.watchers.length && !handoff.disabledReason;
  return (
    <>
      <Button
        ref={trigger}
        data-artifact-handoff
        variant="primary"
        className="whitespace-nowrap"
        disabled={!!handoff.disabledReason || handoff.isPending}
        title={handoff.disabledReason ?? undefined}
        aria-haspopup={handoff.watchers.length ? undefined : "dialog"}
        aria-expanded={handoff.watchers.length ? undefined : showCommand}
        aria-controls={showCommand ? id : undefined}
        onClick={() => (handoff.watchers.length ? handoff.send() : setOpen(!open))}
      >
        {handoff.label}
      </Button>
      {showCommand && (
        <FeedbackCommand
          id={id}
          artifactId={handoff.artifactId}
          trigger={trigger}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function FeedbackCommand({
  id,
  artifactId,
  trigger,
  onClose,
}: {
  id: string;
  artifactId: string;
  trigger: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const popup = useRef<HTMLDivElement>(null);
  const { copied, flash } = useCopyFlash();
  const [error, setError] = useState("");
  const argument = /^[a-zA-Z0-9_-]+$/.test(artifactId)
    ? artifactId
    : `'${artifactId.replaceAll("'", "'\\''")}'`;
  const command = `r3 feedback fetch ${argument}`;
  useLayoutEffect(() => {
    const node = popup.current;
    const button = trigger.current;
    if (!node || !button) return;
    // The browser's top layer keeps the command above clipped feedback panes.
    node.showPopover();
    const place = () => {
      if (!button.getClientRects().length) {
        node.hidePopover();
        return;
      }
      const anchor = button.getBoundingClientRect();
      const bounds = node.getBoundingClientRect();
      node.style.left = `${Math.max(8, Math.min(anchor.right - bounds.width, innerWidth - bounds.width - 8))}px`;
      const top =
        anchor.bottom + bounds.height + 16 <= innerHeight
          ? anchor.bottom + 8
          : anchor.top - bounds.height - 8;
      node.style.top = `${Math.max(8, Math.min(top, innerHeight - bounds.height - 8))}px`;
    };
    place();
    const resize = new ResizeObserver(place);
    resize.observe(node);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      resize.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [trigger]);
  usePopoverFocus(true, popup, trigger);
  useEscape(true, onClose);
  return (
    <div
      ref={popup}
      id={id}
      popover="auto"
      role="dialog"
      aria-label="Read feedback in your agent"
      onToggle={(event) => {
        if (event.newState === "closed") onClose();
      }}
      className="fixed inset-auto m-0 w-80 max-w-[calc(100vw-1rem)] rounded-lg border border-neutral-300 bg-white p-3 text-neutral-900 r3-popover dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
    >
      <p className="text-xs font-semibold">Read feedback in your agent</p>
      <p className="mt-1 text-xs text-neutral-500">
        Run <code>!</code> followed by this command in your agent harness.
      </p>
      <div className="mt-3 flex items-start gap-2 border border-neutral-200 bg-neutral-50 p-2 dark:border-neutral-800 dark:bg-neutral-900">
        <code className="min-w-0 flex-1 break-all text-xs leading-5">{command}</code>
        <Button
          variant="ghost"
          aria-label={copied ? "Command copied" : "Copy command"}
          title={copied ? "Copied" : "Copy command"}
          onClick={async () => {
            setError("");
            if (await copyText(command)) flash();
            else setError("Clipboard access failed. Select and copy the command above.");
          }}
        >
          <StrokeIcon className="size-3.5">
            {copied ? (
              <path d="m5 12 4 4L19 6" />
            ) : (
              <>
                <rect x="9" y="9" width="12" height="12" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </>
            )}
          </StrokeIcon>
        </Button>
      </div>
      <p className="mt-2 text-xs text-neutral-500">
        Loads new feedback and replies. Supported agents also listen for future feedback.
      </p>
      {error && (
        <p role="alert" className="mt-2 text-xs text-red-600">
          {error}
        </p>
      )}
      <span role="status" className="sr-only">
        {copied ? "Command copied" : ""}
      </span>
    </div>
  );
}
