import { useId } from "react";
import { type ArtifactDiscussion, hasUnsentArtifactDiscussion } from "../../../shared/artifacts.ts";
import { artifactNeedsAttention } from "../artifact-discussions.ts";
import { useArtifactDraftCount } from "../artifact-drafts.ts";
import { Button, StrokeIcon } from "../ui.tsx";

// Only the draft count is subscribed; typing does not rerender the navbar.
export function ArtifactDiscussionToggle({
  disabled = false,
  artifactId,
  discussions,
  visible,
  onToggle,
}: {
  disabled?: boolean;
  artifactId: string;
  discussions: ArtifactDiscussion[];
  visible: boolean;
  onToggle: () => void;
}) {
  const drafts = useArtifactDraftCount(artifactId);
  const descriptionId = useId();
  const unhandled = discussions.filter(artifactNeedsAttention).length;
  const unsent = discussions.filter(hasUnsentArtifactDiscussion).length;
  const description = `${unhandled} unhandled ${unhandled === 1 ? "thread" : "threads"} · ${drafts} ${drafts === 1 ? "draft" : "drafts"} · ${unsent} not sent`;
  return (
    <Button
      disabled={disabled}
      variant={visible ? "primary-outline" : "nav"}
      className="relative h-[calc(1.75rem-2px)] w-7 shrink-0 justify-center p-0! max-md:hidden"
      aria-label={visible ? "Hide discussions" : "Show discussions"}
      aria-describedby={descriptionId}
      title={`${visible ? "Hide" : "Show"} discussions (p)\n${description}`}
      aria-pressed={visible}
      onClick={onToggle}
    >
      <StrokeIcon className="size-4">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M14 4v16M17 8h1M17 12h1" />
      </StrokeIcon>
      {unhandled > 0 && (
        <span
          aria-hidden="true"
          data-discussions-attention
          className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary-600 ring-1 ring-white dark:bg-primary-400 dark:ring-neutral-950"
        />
      )}
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
    </Button>
  );
}
