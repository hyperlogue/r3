import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import type { ArtifactDetail } from "../../shared/artifacts.ts";
import { artifactDrafts, useArtifactDraft } from "./artifact-drafts.ts";
import { targetLabel } from "./artifact-labels.ts";
import { withSavedComment } from "./artifact-threads.ts";
import type { ArtifactPageClient } from "./artifact-ui-context.tsx";
import { draftAttachmentInputs } from "./attachment-drafts.ts";
import type { ArtifactRefJump } from "./components/ArtifactThreads.tsx";
import { MediaTargetPreview } from "./components/MediaTargetPreview.tsx";
import { MessageProse } from "./components/Message.tsx";
import { MessageAttachments } from "./components/MessageAttachments.tsx";
import { discussionOutbox, type OutgoingMessage } from "./discussion-outbox.ts";
import { useTranslation } from "./i18n.ts";
import { Button } from "./ui.tsx";

const sending = new Set<string>();
export function useDiscussionOutbox(client: ArtifactPageClient) {
  const qc = useQueryClient();
  useEffect(() => {
    let stopped = false;
    const send = async (item: OutgoingMessage) => {
      if (sending.has(item.id)) return;
      sending.add(item.id);
      const run = async () => {
        discussionOutbox.reload();
        if (
          stopped ||
          !discussionOutbox
            .snapshot()
            .some(
              (entry) => entry.id === item.id && !entry.failed && entry.nextAttempt <= Date.now(),
            )
        )
          return;
        try {
          const attachments = await draftAttachmentInputs(item.draft.attachments);
          const mediaSnapshot =
            item.draft.target.kind === "media" && item.draft.mediaSnapshot
              ? (await draftAttachmentInputs([item.draft.mediaSnapshot]))[0]
              : undefined;
          const options = { attachments, operationKey: item.id };
          if (stopped || !discussionOutbox.snapshot().some((entry) => entry.id === item.id)) return;
          const saved = item.threadId
            ? await client.comment(item.threadId, { body: item.draft.body, ...options })
            : await client.addThread(item.artifactId, item.draft.body, item.draft.target, {
                ...options,
                mediaSnapshot,
              });
          if (stopped || !discussionOutbox.snapshot().some((entry) => entry.id === item.id)) return;
          await qc.cancelQueries({ queryKey: ["artifact", item.artifactId], exact: true });
          if (stopped || !discussionOutbox.snapshot().some((entry) => entry.id === item.id)) return;
          flushSync(() => {
            qc.setQueryData<ArtifactDetail>(["artifact", item.artifactId], (detail) =>
              !detail
                ? detail
                : "threadId" in saved
                  ? withSavedComment(detail, saved)
                  : detail.threads.some((thread) => thread.id === saved.id)
                    ? detail
                    : { ...detail, threads: [...detail.threads, saved] },
            );
            discussionOutbox.remove(item.id);
          });
          void qc.invalidateQueries({ queryKey: ["artifact", item.artifactId] });
          void qc.invalidateQueries({ queryKey: ["artifacts"] });
        } catch (error) {
          // A full disk must not turn a background failure into an unhandled rejection.
          try {
            discussionOutbox.reject(item, error);
          } catch {
            /* The original queued operation remains durable. */
          }
        }
      };
      try {
        if (navigator.locks) await navigator.locks.request(`r3-message-${item.id}`, run);
        else await run(); // Operation keys also deduplicate across tabs without Web Locks.
      } catch {
        /* Retry storage/lock failures on the next tick. */
      } finally {
        sending.delete(item.id);
      }
    };
    const pump = () => {
      if (stopped || !navigator.onLine) return;
      const blocked = new Set<string>();
      for (const item of discussionOutbox.snapshot()) {
        const destination = item.threadId ?? item.id;
        if (blocked.has(destination)) continue;
        blocked.add(destination);
        if (!item.failed && item.nextAttempt <= Date.now()) void send(item);
      }
    };
    const reconnect = () => {
      for (const item of discussionOutbox.snapshot())
        if (!item.failed) discussionOutbox.retry(item.id);
      pump();
    };
    const unsubscribe = discussionOutbox.subscribe(pump);
    const timer = setInterval(pump, 1000);
    window.addEventListener("online", reconnect);
    pump();
    return () => {
      stopped = true;
      unsubscribe();
      clearInterval(timer);
      window.removeEventListener("online", reconnect);
    };
  }, [client, qc]);
}

export function PendingMessages({
  artifactId,
  threadId,
  knownThreads,
  readOnly = false,
  onJumpRef,
}: {
  artifactId: string;
  threadId?: string;
  knownThreads?: readonly string[];
  readOnly?: boolean;
  onJumpRef?: ArtifactRefJump;
}) {
  const items = useSyncExternalStore(discussionOutbox.subscribe, discussionOutbox.snapshot);
  return items
    .filter(
      (item) =>
        item.artifactId === artifactId &&
        (item.threadId === threadId ||
          (knownThreads && item.threadId && !knownThreads.includes(item.threadId))),
    )
    .map((item) => (
      <PendingMessage
        key={item.id}
        item={item}
        onJumpRef={onJumpRef}
        readOnly={readOnly}
        orphan={!!knownThreads && !!item.threadId}
      />
    ));
}
function PendingMessage({
  item,
  orphan,
  readOnly,
  onJumpRef,
}: {
  item: OutgoingMessage;
  orphan: boolean;
  readOnly: boolean;
  onJumpRef?: ArtifactRefJump;
}) {
  const { t } = useTranslation();
  const draft = useArtifactDraft(item.artifactId, item.threadId);
  return (
    <div
      data-outgoing-message={item.id}
      className="border-t border-neutral-200 px-3 py-3 text-sm dark:border-neutral-800"
    >
      {(!item.threadId || orphan) && (
        <p className="mb-2 text-xs text-neutral-500">
          {orphan ? t("outbox.missingThread") : targetLabel(item.draft.target)}
        </p>
      )}
      {item.draft.target.kind === "media" && item.draft.mediaSnapshot && (
        <MediaTargetPreview image={item.draft.mediaSnapshot} box={item.draft.target.locator.box} />
      )}
      <MessageProse
        source={item.draft.body}
        onJumpRef={(ref) => onJumpRef?.(ref, item.draft.context)}
      />
      <MessageAttachments artifactId={item.artifactId} images={item.draft.attachments} />
      <p role="status" className="mt-2 text-xs text-neutral-500">
        {item.failed ? t("outbox.failed", { error: item.error }) : t("outbox.pending")}
      </p>
      {item.failed && (
        <div className="mt-2 flex gap-2">
          <Button disabled={readOnly} onClick={() => discussionOutbox.retry(item.id)}>
            {t("common.retry")}
          </Button>
          {!orphan && (
            <Button
              disabled={!!draft && (!!draft.body.trim() || !!draft.attachments?.length)}
              onClick={() => {
                artifactDrafts.update(item.artifactId, item.draft, item.threadId);
                if (artifactDrafts.flush()) discussionOutbox.remove(item.id);
              }}
            >
              {t("outbox.moveToDraft")}
            </Button>
          )}
          <Button onClick={() => discussionOutbox.remove(item.id)}>{t("outbox.discard")}</Button>
        </div>
      )}
    </div>
  );
}

export function useOutgoingCount(artifactId: string) {
  return useSyncExternalStore(discussionOutbox.subscribe, discussionOutbox.snapshot).filter(
    (item) => item.artifactId === artifactId,
  ).length;
}
