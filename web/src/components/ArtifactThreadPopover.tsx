import { useEffect, useRef } from "react";
import type { ArtifactFeedback, ArtifactMessageContext } from "../../../shared/artifacts.ts";
import { suspendKeys } from "../keys.ts";
import { Button } from "../ui.tsx";
import {
  type ArtifactRefJump,
  type ArtifactTargetJump,
  ArtifactThreadCard,
} from "./ArtifactThreads.tsx";

// One conversation uses the same card, server mutations, and draft store as the
// full panel. Its container owns only focus and dismissal, never feedback state.
export function ArtifactThreadPopover({
  feedback,
  context,
  onLocate,
  onJumpRef,
  onExpand,
  onClose,
}: {
  feedback: ArtifactFeedback;
  context: ArtifactMessageContext;
  onLocate: ArtifactTargetJump;
  onJumpRef: ArtifactRefJump;
  onExpand: () => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    const resume = suspendKeys();
    root.current?.focus({ preventScroll: true });
    return () => {
      resume();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
    };
  }, []);
  return (
    <div
      ref={root}
      role="dialog"
      aria-label="Feedback thread"
      tabIndex={-1}
      data-artifact-thread-popover
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
      className="r3-fade-slide-in flex max-h-full min-h-0 flex-col overflow-hidden rounded-lg border border-neutral-300 bg-white shadow-xl outline-none dark:border-neutral-700 dark:bg-neutral-950"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-3 py-2 dark:border-neutral-800">
        <span className="flex-1 text-sm font-semibold">Thread</span>
        <Button variant="ghost" onClick={onExpand}>
          Open all feedback
        </Button>
        <Button variant="ghost" aria-label="Close thread" onClick={onClose}>
          ×
        </Button>
      </div>
      <div className="min-h-0 overflow-y-auto">
        <ArtifactThreadCard
          feedback={feedback}
          context={context}
          onLocate={onLocate}
          onJumpRef={onJumpRef}
        />
      </div>
    </div>
  );
}
