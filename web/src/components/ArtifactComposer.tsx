import { useMutation } from "@tanstack/react-query";
import { useRef } from "react";
import { createPortal, flushSync } from "react-dom";
import { hasMessageContent } from "../../../shared/attachments.ts";
import { type ArtifactDraft, artifactDrafts, useArtifactDraft } from "../artifact-drafts.ts";
import { targetLabel as artifactTargetLabel } from "../artifact-labels.ts";
import { draftImages } from "../attachment-drafts.ts";
import { discussionOutbox } from "../discussion-outbox.ts";
import { useTranslation } from "../i18n.ts";
import { type ImageInsertion, imageMessageBody } from "../image-placeholders.ts";
import { prepareThreadMorph } from "../thread-motion.ts";
import { Button, cn, StrokeIcon } from "../ui.tsx";
import { useFloatingComposer } from "../useFloatingComposer.ts";
import { MediaTargetPreview } from "./MediaTargetPreview.tsx";
import {
  type EditableImage,
  MessageAttachments,
  useAttachmentInput,
} from "./MessageAttachments.tsx";
import { MessageInput } from "./MessageInput.tsx";

// Draft subscription and mutation live with the textarea. Typing does not
// subscribe the conversation list or the content pane to every character.
export function ArtifactComposer({
  artifactId,
  commentTo,
  onDone,
  floating,
  readOnly = false,
}: {
  artifactId: string;
  readOnly?: boolean;
  commentTo?: string;
  onDone?: () => void;
  floating?: { left: number; top: number; bottom: number; onClose: () => void };
}) {
  const { t } = useTranslation();
  const draft = useArtifactDraft(artifactId, commentTo);
  const retiredTarget =
    !commentTo &&
    (draft?.target.kind === "version_summary" || draft?.target.kind === "artifact_summary");
  const formElement = useRef<HTMLFormElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const floatingComposer = useFloatingComposer(floating);
  const post = useMutation({
    networkMode: "always",
    mutationFn: async (submitted: ArtifactDraft) => {
      const generation = discussionOutbox.generation;
      await draftImages.requirePersisted([
        ...(submitted.attachments ?? []).map((image) => image.id),
        ...(submitted.target.kind === "media" && submitted.mediaSnapshot
          ? [submitted.mediaSnapshot.id]
          : []),
      ]);
      if (!commentTo && submitted.operationKey)
        prepareThreadMorph(formElement.current, submitted.operationKey);
      let cleared = false;
      flushSync(() => {
        discussionOutbox.enqueue(artifactId, submitted, commentTo, generation);
        cleared = artifactDrafts.clearIfCurrent(artifactId, submitted, commentTo);
      });
      artifactDrafts.flush();
      if (cleared) onDone?.();
    },
  });
  const changeImages = (
    change: (images: EditableImage[]) => EditableImage[],
    insertion?: ImageInsertion,
  ) => {
    const held = artifactDrafts.get(artifactId, commentTo);
    const before = held?.attachments ?? [];
    const after = change(before);
    if (before.length === after.length && before.every((image, i) => image === after[i])) return;
    artifactDrafts.update(
      artifactId,
      {
        attachments: after,
        body: imageMessageBody(held?.body ?? "", before, after, insertion),
      },
      commentTo,
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
        {t("composer.archivedRestoreThisArtifactToContinueThe")}
      </p>
    );
  const context = draft?.context;
  const form = (
    <form
      ref={formElement}
      className={cn(
        "relative flex flex-col gap-2 bg-white py-3 dark:bg-neutral-950",
        !commentTo &&
          !floating &&
          "border-b border-neutral-200 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary-500 dark:border-neutral-800",
      )}
      data-artifact-composer={artifactId}
      data-comment-to={commentTo}
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
            artifactDrafts.update(artifactId, { operationKey: crypto.randomUUID() }, commentTo);
            artifactDrafts.flush();
          }
          post.mutate(artifactDrafts.get(artifactId, commentTo)!);
        }
      }}
    >
      {(!commentTo || !!context?.versionSeq || floating) && (
        <div className="flex items-start justify-between gap-2 px-3 text-xs text-neutral-500">
          {floating && (
            <button
              type="button"
              tabIndex={-1}
              aria-label={t("composer.moveComposer")}
              title={t("composer.dragToMove")}
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
            {commentTo
              ? context?.versionSeq
                ? t("composer.commentAboutVersion", {
                    context_versionSeq: context.versionSeq,
                    context_representation_context_representation: context.representation
                      ? ` · ${context.representation}`
                      : "",
                  })
                : null
              : artifactTargetLabel(draft?.target ?? { kind: "artifact" })}
          </span>
          {!commentTo && draft?.target.kind !== "artifact" && draft?.target && (
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
              {t("composer.clearTarget")}
            </button>
          )}
          {floating && (
            <Button
              type="button"
              variant="ghost"
              aria-label={t("composer.closeComposer")}
              onClick={floating.onClose}
            >
              ×
            </Button>
          )}
        </div>
      )}
      {draft?.imported && (
        <p className="text-xs text-amber-700 dark:text-amber-400">
          {t("composer.importedDraftItsOriginalPublishedContextIs")}
        </p>
      )}
      {retiredTarget && (
        <p className="px-3 text-xs text-amber-700 dark:text-amber-400">
          {t("composer.descriptionAnchoringIsNoLongerSupportedClear")}
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
      {!commentTo && draft?.target.kind === "media" && draft.mediaSnapshot && (
        <MediaTargetPreview image={draft.mediaSnapshot} box={draft.target.locator.box} />
      )}
      <MessageInput
        inputRef={textarea}
        aria-label={commentTo ? t("thread.reply") : t("composer.comment")}
        placeholder={commentTo ? t("composer.writeAReply") : t("composer.writeAComment")}
        disabled={post.isPending}
        value={draft?.body ?? ""}
        onChange={(event) =>
          artifactDrafts.update(artifactId, { body: event.target.value }, commentTo)
        }
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            if (!event.repeat) event.currentTarget.form?.requestSubmit();
          } else if (event.key === "Escape" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            if (!hasMessageContent(draft)) {
              artifactDrafts.clear(artifactId, commentTo);
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
            artifactDrafts.clear(artifactId, commentTo);
            onDone?.();
          }}
        >
          {hasMessageContent(draft) ? t("composer.discard") : t("common.cancel")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          disabled={
            !hasMessageContent(draft) || attachments.unfinished || post.isPending || retiredTarget
          }
        >
          {post.isPending
            ? t("composer.posting")
            : commentTo
              ? t("composer.comment")
              : t("thread.addComment")}
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
