import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { type ArtifactDetail, hasUnsentArtifactThread } from "../../shared/artifacts.ts";
import { useArtifactDraftCount } from "./artifact-drafts.ts";
import { useDiscussionHandoffReceipt } from "./artifact-handoff.ts";
import { useThreadStatusPending } from "./artifact-thread-status.ts";
import { useArtifactClient } from "./artifact-ui-context.tsx";
import { t, useLocale } from "./i18n.ts";
import { useCopyFlash } from "./ui.tsx";

// The navbar and panel share delivery rules, receipts, and a mutation key so
// either control can send a batch without duplicating an in-flight handoff.
export function useArtifactHandoff(detail: ArtifactDetail) {
  useLocale();
  const artifactApi = useArtifactClient();
  const qc = useQueryClient();
  const mutationKey = ["artifact-handoff", detail.id];
  const isPending = useIsMutating({ mutationKey }) > 0;
  const draftCount = useArtifactDraftCount(detail.id);
  const savingStatus = useThreadStatusPending(detail.id);
  const comments = useMemo(
    () => detail.events.flatMap((event) => (event.comment ? [event.comment] : [])),
    [detail.events],
  );
  const receipt = useDiscussionHandoffReceipt(detail.id, detail.threads, comments);
  const { copied: sent, flash: showSent } = useCopyFlash(3000);
  const [notice, setNotice] = useState("");
  const { data: watchers = [], isPending: loadingWatchers } = useQuery({
    queryKey: ["artifact-watchers", detail.id],
    queryFn: () => artifactApi.watchers(detail.id),
  });
  const pending =
    detail.threads.filter(hasUnsentArtifactThread).length +
    comments.filter((comment) => comment.author.role === "human" && comment.sentAt === null).length;
  const disabledReason =
    detail.state === "archived"
      ? t("Restore the artifact to send comments")
      : loadingWatchers
        ? t("Checking for an agent")
        : !watchers.length
          ? null
          : savingStatus
            ? t("Saving thread status")
            : draftCount
              ? t("Post or discard drafts before sending comments")
              : !pending
                ? t("No new comments or status changes to send")
                : receipt.hashes === null
                  ? t("Checking pending comments")
                  : receipt.covered
                    ? t("Already sent. Add or update a comment to send again.")
                    : null;
  const mutation = useMutation({
    mutationKey,
    mutationFn: async () => {
      setNotice("");
      if (watchers.length) {
        const snapshot = receipt.begin();
        if (!snapshot) throw new Error(t("Pending comments are still loading. Try again."));
        const result = await artifactApi.submit(detail.id);
        if (result.notification.state !== "sent" && result.notification.state !== "queued")
          throw new Error(
            result.notification.state === "failed"
              ? result.notification.error
              : t("No agent accepted the notification."),
          );
        receipt.remember(snapshot);
        setNotice(t("Your thread is ready for the agent to fetch."));
        showSent();
      }
    },
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["artifact", detail.id] }),
        qc.invalidateQueries({ queryKey: ["artifact-watchers", detail.id] }),
      ]),
  });
  return {
    artifactId: detail.id,
    watchers,
    draftCount,
    pending,
    disabledReason,
    isPending,
    showAction:
      (!watchers.length && detail.state === "active") ||
      (pending > 0 && !receipt.covered) ||
      isPending ||
      sent,
    label: !watchers.length
      ? t("Use in agent")
      : sent && (receipt.covered || !pending)
        ? t("Sent")
        : isPending
          ? t("Sending…")
          : t("Send to agent{pending_pending}", {
              pending_pending: pending ? ` · ${pending}` : "",
            }),
    notice,
    error: mutation.error,
    dismiss: () => {
      setNotice("");
      mutation.reset();
    },
    send: () => {
      if (watchers.length && !disabledReason && !qc.isMutating({ mutationKey })) mutation.mutate();
    },
  };
}
