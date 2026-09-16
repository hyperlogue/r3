import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useContext, useRef } from "react";
import { createPortal, flushSync } from "react-dom";
import { artifactTargetLabel } from "../../../shared/artifact-prompt.ts";
import type { ArtifactDetail } from "../../../shared/artifacts.ts";
import { artifactApi } from "../artifact-api.ts";
import { artifactDrafts, useArtifactDraft } from "../artifact-drafts.ts";
import { FeedbackCreationContext, prepareFeedbackMorph } from "../feedback-motion.ts";
import { Button, cn } from "../ui.tsx";
import { MessageInput } from "./MessageInput.tsx";

// Draft subscription and mutation live with the textarea. Typing does not
// subscribe the conversation list or the content pane to every character.
export function ArtifactComposer({
  artifactId,
  replyTo,
  onDone,
  floating,
  leadingActions,
}: {
  artifactId: string;
  replyTo?: string;
  onDone?: () => void;
  floating?: { left: number; top: number; bottom: number; onClose: () => void };
  leadingActions?: ReactNode;
}) {
  const draft = useArtifactDraft(artifactId, replyTo);
  const retiredTarget =
    !replyTo &&
    (draft?.target.kind === "version_summary" || draft?.target.kind === "artifact_summary");
  const formElement = useRef<HTMLFormElement>(null);
  const qc = useQueryClient();
  const showCreated = useContext(FeedbackCreationContext);
  const post = useMutation({
    mutationFn: async () => {
      if (!draft?.body.trim() || retiredTarget) return;
      if (replyTo) await artifactApi.reply(replyTo, { body: draft.body, context: draft.context });
      else return artifactApi.addFeedback(artifactId, draft.body, draft.target);
    },
    onSuccess: async (feedback) => {
      let release: (() => void) | undefined;
      if (feedback) {
        // Do not let an older in-flight read replace the acknowledged note.
        await qc.cancelQueries({ queryKey: ["artifact", artifactId], exact: true });
        prepareFeedbackMorph(formElement.current, feedback.id);
        flushSync(() => {
          release = showCreated?.(feedback);
          qc.setQueryData<ArtifactDetail>(["artifact", artifactId], (current) =>
            !current || current.feedback.some((note) => note.id === feedback.id)
              ? current
              : { ...current, feedback: [...current.feedback, feedback] },
          );
          artifactDrafts.clear(artifactId);
        });
      } else {
        artifactDrafts.clear(artifactId, replyTo);
      }
      onDone?.();
      void qc.invalidateQueries({ queryKey: ["artifact", artifactId] }).finally(() => release?.());
    },
  });
  const context = draft?.context;
  const form = (
    <form
      ref={formElement}
      className={cn(
        "relative flex flex-col gap-2 bg-white py-3 dark:bg-neutral-950",
        !replyTo &&
          !floating &&
          "border-b border-neutral-200 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary-500 dark:border-neutral-800",
      )}
      data-artifact-composer={artifactId}
      data-reply-to={replyTo}
      onSubmit={(event) => {
        event.preventDefault();
        if (draft?.body.trim() && !post.isPending && !retiredTarget) post.mutate();
      }}
    >
      <div className="flex items-start justify-between gap-2 px-3 text-xs text-neutral-500">
        <span>
          {replyTo
            ? context?.versionSeq
              ? `Reply about version ${context.versionSeq}${context.representation ? ` · ${context.representation}` : ""}`
              : "Reply without a published context"
            : artifactTargetLabel(draft?.target ?? { kind: "artifact" })}
        </span>
        {floating && (
          <Button
            type="button"
            variant="ghost"
            aria-label="Close composer"
            onClick={floating.onClose}
          >
            ×
          </Button>
        )}
        {!replyTo && draft?.target.kind !== "artifact" && draft?.target && (
          <button
            type="button"
            className="shrink-0 underline"
            onClick={() => artifactDrafts.update(artifactId, { target: { kind: "artifact" } })}
          >
            Clear target
          </button>
        )}
      </div>
      {draft?.imported && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          Imported draft. Its original published context is unknown; the saved text and anchor
          evidence are preserved.
        </p>
      )}
      {retiredTarget && (
        <p className="px-3 text-xs text-amber-700 dark:text-amber-400">
          Description anchoring is no longer supported. Clear the target to post this draft as
          general feedback.
        </p>
      )}
      {draft &&
        "locator" in draft.target &&
        draft.target.locator &&
        "quote" in draft.target.locator &&
        draft.target.locator.quote && (
          <blockquote className="max-h-24 overflow-auto border-l-2 border-neutral-300 pl-2 text-xs text-neutral-500 whitespace-pre-wrap">
            {draft.target.locator.quote}
          </blockquote>
        )}
      <MessageInput
        aria-label={replyTo ? "Reply" : "Feedback"}
        placeholder={replyTo ? "Write a reply…" : "Write feedback…"}
        disabled={post.isPending}
        value={draft?.body ?? ""}
        onChange={(event) =>
          artifactDrafts.update(artifactId, { body: event.target.value }, replyTo)
        }
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (!event.repeat) event.currentTarget.form?.requestSubmit();
          } else if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            if (!draft?.body.trim()) {
              artifactDrafts.clear(artifactId, replyTo);
              onDone?.();
            } else event.currentTarget.blur();
          }
        }}
      />
      {post.error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {post.error.message}
        </p>
      )}
      <div className="flex items-center gap-2 px-3">
        {leadingActions}
        <span className="flex-1" />
        <Button
          type="button"
          disabled={post.isPending}
          onClick={() => {
            artifactDrafts.clear(artifactId, replyTo);
            onDone?.();
          }}
        >
          {draft?.body ? "Discard" : "Cancel"}
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={!draft?.body.trim() || post.isPending || retiredTarget}
        >
          {post.isPending ? "Posting…" : replyTo ? "Reply" : "Add feedback"}
        </Button>
      </div>
    </form>
  );
  if (!floating) return form;
  const width = Math.min(440, window.innerWidth - 32);
  const above = floating.bottom > window.innerHeight / 2;
  return createPortal(
    <div
      className="fixed z-50 max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-lg border border-neutral-300 bg-white r3-floating will-change-transform dark:border-neutral-700 dark:bg-neutral-950"
      style={{
        width,
        left: Math.max(16, Math.min(window.innerWidth - width - 16, floating.left - width / 2)),
        ...(above
          ? { bottom: Math.max(16, window.innerHeight - floating.top + 8) }
          : { top: Math.max(16, floating.bottom + 8) }),
      }}
    >
      {form}
    </div>,
    document.body,
  );
}
