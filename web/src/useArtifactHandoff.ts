import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { type ArtifactDetail, hasUnsentArtifactDiscussion } from "../../shared/artifacts.ts";
import { useDiscussionStatusPending } from "./artifact-discussions-status.ts";
import { useArtifactDraftCount } from "./artifact-drafts.ts";
import { useDiscussionHandoffReceipt } from "./artifact-handoff.ts";
import { useArtifactClient } from "./artifact-ui-context.tsx";
import { useCopyFlash } from "./ui.tsx";

// The navbar and panel share delivery rules, receipts, and a mutation key so
// either control can send a batch without duplicating an in-flight handoff.
export function useArtifactHandoff(detail: ArtifactDetail) {
  const artifactApi = useArtifactClient();
  const qc = useQueryClient();
  const mutationKey = ["artifact-handoff", detail.id];
  const isPending = useIsMutating({ mutationKey }) > 0;
  const draftCount = useArtifactDraftCount(detail.id);
  const savingStatus = useDiscussionStatusPending(detail.id);
  const comments = useMemo(
    () => detail.events.flatMap((event) => (event.comment ? [event.comment] : [])),
    [detail.events],
  );
  const receipt = useDiscussionHandoffReceipt(detail.id, detail.discussions, comments);
  const { copied: sent, flash: showSent } = useCopyFlash(3000);
  const [notice, setNotice] = useState("");
  const { data: watchers = [], isPending: loadingWatchers } = useQuery({
    queryKey: ["artifact-watchers", detail.id],
    queryFn: () => artifactApi.watchers(detail.id),
  });
  const pending =
    detail.discussions.filter(hasUnsentArtifactDiscussion).length +
    comments.filter((comment) => comment.author.role === "human" && comment.sentAt === null).length;
  const disabledReason =
    detail.state === "archived"
      ? "Restore the artifact to send discussions"
      : loadingWatchers
        ? "Checking for an agent"
        : !watchers.length
          ? null
          : savingStatus
            ? "Saving discussions status"
            : draftCount
              ? "Post or discard drafts before sending discussions"
              : !pending
                ? "No new discussions to send"
                : receipt.hashes === null
                  ? "Checking pending discussions"
                  : receipt.covered
                    ? "Already sent. Add or update discussions to send again."
                    : null;
  const mutation = useMutation({
    mutationKey,
    mutationFn: async () => {
      setNotice("");
      if (watchers.length) {
        const snapshot = receipt.begin();
        if (!snapshot) throw new Error("Pending discussion is still loading. Try again.");
        const result = await artifactApi.submit(detail.id);
        if (result.notification.state !== "sent" && result.notification.state !== "queued")
          throw new Error(
            result.notification.state === "failed"
              ? result.notification.error
              : "No agent accepted the notification.",
          );
        receipt.remember(snapshot);
        setNotice("Your discussion is ready for the agent to fetch.");
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
      ? "Use in agent"
      : sent && (receipt.covered || !pending)
        ? "Sent"
        : isPending
          ? "Sending…"
          : `Send to agent${pending ? ` · ${pending}` : ""}`,
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
