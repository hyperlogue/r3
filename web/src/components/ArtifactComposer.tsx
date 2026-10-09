import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useContext, useRef } from "react";
import { createPortal, flushSync } from "react-dom";
import { artifactTargetLabel } from "../../../shared/artifact-prompt.ts";
import type { ArtifactDetail } from "../../../shared/artifacts.ts";
import { hasMessageContent } from "../../../shared/attachments.ts";
import { artifactApi } from "../artifact-api.ts";
import { type ArtifactDraft, artifactDrafts, useArtifactDraft } from "../artifact-drafts.ts";
import { withSavedReply } from "../artifact-feedback.ts";
import { draftAttachmentInputs } from "../attachment-drafts.ts";
import { FeedbackCreationContext, prepareFeedbackMorph } from "../feedback-motion.ts";
import { type ImageInsertion, imageMessageBody } from "../image-placeholders.ts";
import { Button, cn, StrokeIcon } from "../ui.tsx";
import { useFloatingComposer } from "../useFloatingComposer.ts";
import { MediaTargetPreview } from "./MediaTargetPreview.tsx";
import {
  type EditableImage,
  editableImageInputs,
  MessageAttachments,
  useAttachmentInput,
} from "./MessageAttachments.tsx";
import { MessageInput } from "./MessageInput.tsx";

// Draft subscription and mutation live with the textarea. Typing does not
// subscribe the conversation list or the content pane to every character.
export function ArtifactComposer({
  artifactId,
  replyTo,
  onDone,
  floating,
  readOnly = false,
}: {
  artifactId: string;
  readOnly?: boolean;
  replyTo?: string;
  onDone?: () => void;
  floating?: { left: number; top: number; bottom: number; onClose: () => void };
}) {
  const draft = useArtifactDraft(artifactId, replyTo);
  const retiredTarget =
    !replyTo &&
    (draft?.target.kind === "version_summary" || draft?.target.kind === "artifact_summary");
  const formElement = useRef<HTMLFormElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const floatingComposer = useFloatingComposer(floating);
  const qc = useQueryClient();
  const showCreated = useContext(FeedbackCreationContext);
  const post = useMutation({
    mutationFn: async (submitted: ArtifactDraft) => {
      const attachments = await editableImageInputs(submitted.attachments ?? []);
      if (replyTo)
        return artifactApi.reply(replyTo, {
          body: submitted.body,
          attachments,
          operationKey: submitted.operationKey,
        });
      else
        return artifactApi.addFeedback(artifactId, submitted.body, submitted.target, {
          attachments,
          operationKey: submitted.operationKey,
          mediaSnapshot:
            submitted.target.kind === "media" && submitted.mediaSnapshot
              ? (await draftAttachmentInputs([submitted.mediaSnapshot]))[0]
              : undefined,
        });
    },
    onSuccess: async (saved, submitted) => {
      let release: (() => void) | undefined;
      let cleared = false;
      // Do not let an older in-flight read replace the acknowledged note.
      await qc.cancelQueries({ queryKey: ["artifact", artifactId], exact: true });
      if ("feedbackId" in saved) {
        flushSync(() => {
          qc.setQueryData<ArtifactDetail>(["artifact", artifactId], (current) =>
            current ? withSavedReply(current, saved) : current,
          );
          cleared = artifactDrafts.clearIfCurrent(artifactId, submitted, replyTo);
        });
      } else {
        const current = artifactDrafts.get(artifactId) === submitted;
        if (current) prepareFeedbackMorph(formElement.current, saved.id);
        flushSync(() => {
          if (current) release = showCreated?.(saved);
          qc.setQueryData<ArtifactDetail>(["artifact", artifactId], (current) =>
            !current || current.feedback.some((note) => note.id === saved.id)
              ? current
              : { ...current, feedback: [...current.feedback, saved] },
          );
          cleared = artifactDrafts.clearIfCurrent(artifactId, submitted);
        });
      }
      if (cleared) onDone?.();
      void qc.invalidateQueries({ queryKey: ["artifact", artifactId] }).finally(() => release?.());
      void qc.invalidateQueries({ queryKey: ["artifacts"] });
    },
  });
  const changeImages = (
    change: (images: EditableImage[]) => EditableImage[],
    insertion?: ImageInsertion,
  ) => {
    const held = artifactDrafts.get(artifactId, replyTo);
    const before = held?.attachments ?? [];
    const after = change(before);
    if (before.length === after.length && before.every((image, i) => image === after[i])) return;
    artifactDrafts.update(
      artifactId,
      {
        attachments: after,
        body: imageMessageBody(held?.body ?? "", before, after, insertion),
      },
      replyTo,
    );
    artifactDrafts.flush();
  };
  const attachments = useAttachmentInput(
    artifactId,
    draft?.attachments ?? [],
    changeImages,
    post.isPending,
    textarea,
  );
  if (readOnly)
    return (
      <p className="px-3 py-2 text-xs text-neutral-500">
        Archived. Restore this artifact to continue the conversation. Your draft is saved.
      </p>
    );
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
      onPaste={attachments.onPaste}
      onSubmit={(event) => {
        event.preventDefault();
        if (
          draft &&
          hasMessageContent(draft) &&
          !attachments.unfinished &&
          !post.isPending &&
          !retiredTarget
        ) {
          if (!draft.operationKey) {
            artifactDrafts.update(artifactId, { operationKey: crypto.randomUUID() }, replyTo);
            artifactDrafts.flush();
          }
          post.mutate(artifactDrafts.get(artifactId, replyTo)!);
        }
      }}
    >
      <div className="flex items-start justify-between gap-2 px-3 text-xs text-neutral-500">
        {floating && (
          <button
            type="button"
            tabIndex={-1}
            aria-label="Move composer"
            title="Drag to move"
            onPointerDown={floatingComposer.start}
            className="flex size-6 shrink-0 touch-none cursor-grab items-center justify-center rounded text-neutral-400 hover:text-neutral-600 focus-visible:outline-2 focus-visible:outline-primary-500 dark:hover:text-neutral-200"
          >
            <StrokeIcon className="size-4">
              <path
                d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01"
                strokeWidth="3"
                strokeLinecap="round"
              />
            </StrokeIcon>
          </button>
        )}
        <span className={cn(floating && "min-w-0 flex-1 break-words pt-1")}>
          {replyTo
            ? context?.versionSeq
              ? `Reply about version ${context.versionSeq}${context.representation ? ` · ${context.representation}` : ""}`
              : "Reply without a published context"
            : artifactTargetLabel(draft?.target ?? { kind: "artifact" })}
        </span>
        {!replyTo && draft?.target.kind !== "artifact" && draft?.target && (
          <button
            type="button"
            className={cn("shrink-0 underline", floating && "pt-1")}
            onClick={() =>
              artifactDrafts.update(artifactId, {
                target: { kind: "artifact" },
                mediaSnapshot: undefined,
              })
            }
          >
            Clear target
          </button>
        )}
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
      {!replyTo && draft?.target.kind === "media" && draft.mediaSnapshot && (
        <MediaTargetPreview image={draft.mediaSnapshot} box={draft.target.locator.box} />
      )}
      <MessageInput
        inputRef={textarea}
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
            if (!hasMessageContent(draft)) {
              artifactDrafts.clear(artifactId, replyTo);
              onDone?.();
            } else event.currentTarget.blur();
          }
        }}
      />
      <div className="px-3">
        <MessageAttachments
          artifactId={artifactId}
          images={draft?.attachments}
          onChange={changeImages}
          disabled={post.isPending}
        />
      </div>
      {attachments.notice && (
        <p role="status" className="px-3 text-xs text-amber-700">
          {attachments.notice}
        </p>
      )}
      {post.error && (
        <p role="alert" className="text-xs text-red-600 dark:text-red-400">
          {post.error.message}
        </p>
      )}
      <div className="flex items-center gap-2 px-3">
        {attachments.controls}
        <span className="flex-1" />
        <Button
          type="button"
          disabled={post.isPending}
          onClick={() => {
            artifactDrafts.clear(artifactId, replyTo);
            onDone?.();
          }}
        >
          {hasMessageContent(draft) ? "Discard" : "Cancel"}
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={
            !hasMessageContent(draft) || attachments.unfinished || post.isPending || retiredTarget
          }
        >
          {post.isPending ? "Posting…" : replyTo ? "Reply" : "Add feedback"}
        </Button>
      </div>
    </form>
  );
  if (!floating) return form;
  return createPortal(
    <div
      ref={floatingComposer.ref}
      data-floating-composer
      className="fixed z-50 max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-lg border border-neutral-300 bg-white r3-floating will-change-transform dark:border-neutral-700 dark:bg-neutral-950"
      style={{ width: "min(440px, calc(100vw - 2rem))" }}
    >
      {form}
    </div>,
    document.body,
  );
}
