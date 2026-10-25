import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import {
  type ArtifactTarget,
  type ArtifactThread,
  currentThreadTarget,
} from "../../../shared/artifacts.ts";
import { targetLabel } from "../artifact-labels.ts";
import { useTranslation } from "../i18n.ts";
import { StrokeIcon, useEscape, usePopoverFocus } from "../ui.tsx";
import type { ArtifactTargetJump } from "./ArtifactThreads.tsx";

export function ArtifactThreadLocation({
  thread,
  onLocate,
  visible,
  versionSeq,
}: {
  thread: ArtifactThread;
  onLocate: ArtifactTargetJump;
  visible: boolean;
  versionSeq: number | null;
}) {
  const { t } = useTranslation();
  const target = currentThreadTarget(thread);
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const operation = useRef(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!visible) setOpen(false);
  }, [visible]);
  // Changing the viewed publication or correcting the saved anchor retires the
  // old request's UI even if its read is still completing in the query cache.
  // biome-ignore lint/correctness/useExhaustiveDependencies: these identities retire an in-flight navigation
  useEffect(() => {
    ++operation.current;
    setPending(false);
    setOpen(false);
  }, [versionSeq, thread.anchor?.revision]);
  const go = async (target: ArtifactTarget, intent: "viewed" | "recorded") => {
    const nonce = ++operation.current;
    setOpen(false);
    setPending(intent === "viewed");
    try {
      await onLocate(target, thread.id, intent);
    } finally {
      if (nonce === operation.current) setPending(false);
    }
  };
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1">
      <button
        type="button"
        className="min-w-0 break-all text-left text-primary-700 underline-offset-2 hover:underline dark:text-primary-300"
        title={t("threads.anchorPosition")}
        aria-busy={pending}
        data-thread-action="locate"
        onClick={() => void go(target, "viewed")}
      >
        {targetLabel(target, null, true)}
        {pending && <span className="ml-1 text-neutral-500">{t("threads.locating")}</span>}
      </button>
      <button
        ref={trigger}
        type="button"
        data-thread-action="locations"
        className="flex size-6 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-100 hover:text-primary-700 max-md:size-9 dark:hover:bg-neutral-800 dark:hover:text-primary-300"
        title={t("threads.recordedLocations")}
        aria-label={t("threads.recordedLocations")}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
      >
        <StrokeIcon className="size-4" strokeWidth={1.7}>
          <path d="M3 10a9 9 0 1 1 2.7 8.2M3 4v6h6" />
          <path d="M12 7v5l3 2" />
        </StrokeIcon>
      </button>
      {open && visible && (
        <RecordedLocations
          id={id}
          trigger={trigger}
          thread={thread}
          onClose={() => setOpen(false)}
          onGo={(target) => void go(target, "recorded")}
        />
      )}
    </div>
  );
}

function RecordedLocations({
  id,
  trigger,
  thread,
  onGo,
  onClose,
}: {
  id: string;
  trigger: React.RefObject<HTMLButtonElement | null>;
  thread: ArtifactThread;
  onGo: (target: ArtifactTarget) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const popup = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = popup.current;
    const button = trigger.current;
    if (!node || !button) return;
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
  const item = (target: ArtifactTarget, label: string, action: string) => (
    <button
      type="button"
      data-thread-action={action}
      className="block w-full px-3 py-2 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800"
      onClick={() => onGo(target)}
    >
      <span className="font-medium">{label}</span>
      {"versionSeq" in target && (
        <span className="ml-1 text-neutral-500">{`· v${target.versionSeq}`}</span>
      )}
      <span className="mt-0.5 block break-all text-neutral-500">
        {targetLabel(target, null, true)}
      </span>
    </button>
  );
  return (
    <div
      ref={popup}
      id={id}
      popover="auto"
      role="dialog"
      aria-label={t("threads.recordedLocations")}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      onToggle={(event) => {
        if (event.newState === "closed") onClose();
      }}
      className="fixed inset-auto m-0 w-64 max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg border border-neutral-300 bg-white py-1 text-neutral-900 r3-popover dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
    >
      {thread.anchor && item(thread.anchor.target, t("threads.lastRecordedLocation"), "recorded")}
      {item(thread.target, t("threads.originalLocation"), "original")}
    </div>
  );
}
