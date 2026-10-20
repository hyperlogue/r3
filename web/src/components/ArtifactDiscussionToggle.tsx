import { useId } from "react";
import { type ArtifactThread, hasUnsentArtifactThread } from "../../../shared/artifacts.ts";
import { useArtifactDraftCount } from "../artifact-drafts.ts";
import { artifactNeedsAttention } from "../artifact-threads.ts";
import { useTranslation } from "../i18n.ts";
import { Button, StrokeIcon } from "../ui.tsx";

// Only the draft count is subscribed; typing does not rerender the navbar.
export function ArtifactDiscussionToggle({
  disabled = false,
  artifactId,
  threads,
  visible,
  onToggle,
}: {
  disabled?: boolean;
  artifactId: string;
  threads: ArtifactThread[];
  visible: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  const drafts = useArtifactDraftCount(artifactId);
  const descriptionId = useId();
  const unhandled = threads.filter(artifactNeedsAttention).length;
  const unsent = threads.filter(hasUnsentArtifactThread).length;
  const description = t("discussionToggle.unhandledNotSent", {
    unhandled: unhandled,
    unhandled_1_thread_threads: t("discussionToggle.thread", { count: unhandled }),
    drafts: drafts,
    drafts_1_draft_drafts: t("discussionToggle.draft", { count: drafts }),
    unsent: unsent,
  });
  return (
    <Button
      disabled={disabled}
      variant={visible ? "primary-outline" : "nav"}
      className="relative h-[calc(1.75rem-2px)] w-7 shrink-0 justify-center p-0! max-md:hidden"
      aria-label={visible ? t("common.hideDiscussion") : t("discussionToggle.showDiscussion")}
      aria-describedby={descriptionId}
      title={`${visible ? t("common.hideDiscussion") : t("discussionToggle.showDiscussion")} (p)\n${description}`}
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
          data-threads-attention
          className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-primary-600 ring-1 ring-white dark:bg-primary-400 dark:ring-neutral-950"
        />
      )}
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
    </Button>
  );
}
