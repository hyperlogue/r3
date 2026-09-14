import { useId } from "react";
import { type ArtifactFeedback, hasUnsentArtifactFeedback } from "../../../shared/artifacts.ts";
import { useArtifactDraftCount } from "../artifact-drafts.ts";
import { artifactNeedsAttention } from "../artifact-feedback.ts";
import { Button, StrokeIcon } from "../ui.tsx";

// Only the draft count is subscribed; typing does not rerender the navbar.
export function ArtifactFeedbackToggle({
  artifactId,
  feedback,
  visible,
  onToggle,
}: {
  artifactId: string;
  feedback: ArtifactFeedback[];
  visible: boolean;
  onToggle: () => void;
}) {
  const drafts = useArtifactDraftCount(artifactId);
  const descriptionId = useId();
  const unhandled = feedback.filter(artifactNeedsAttention).length;
  const unsent = feedback.filter(hasUnsentArtifactFeedback).length;
  const description = `${unhandled} unhandled ${unhandled === 1 ? "thread" : "threads"} · ${drafts} ${drafts === 1 ? "draft" : "drafts"} · ${unsent} not sent`;
  return (
    <Button
      variant={visible ? "primary-outline" : "nav"}
      className="relative shrink-0 px-1.5 py-[calc(.375rem-1px)] max-md:hidden"
      aria-label={visible ? "Hide feedback" : "Show feedback"}
      aria-describedby={descriptionId}
      title={`${visible ? "Hide" : "Show"} feedback (p)\n${description}`}
      aria-pressed={visible}
      onClick={onToggle}
    >
      <StrokeIcon className="size-4">
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <path d="M14 4v16M17 8h1M17 12h1" />
      </StrokeIcon>
      {(unhandled > 0 || drafts > 0 || unsent > 0) && (
        <span
          aria-hidden="true"
          data-feedback-attention
          className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary-600 ring-1 ring-white dark:bg-primary-400 dark:ring-neutral-950"
        />
      )}
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
    </Button>
  );
}
