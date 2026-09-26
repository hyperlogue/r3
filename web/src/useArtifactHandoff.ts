import { useIsMutating, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type ArtifactDetail, hasUnsentArtifactFeedback } from "../../shared/artifacts.ts";
import { artifactApi } from "./artifact-api.ts";
import { useArtifactDraftCount } from "./artifact-drafts.ts";
import { useFeedbackStatusPending } from "./artifact-feedback-status.ts";
import { useFeedbackHandoffReceipt } from "./artifact-handoff.ts";
import { useCopyFlash } from "./ui.tsx";

// The navbar and panel share delivery rules, receipts, and a mutation key so
// either control can send a batch without duplicating an in-flight handoff.
export function useArtifactHandoff(detail: ArtifactDetail) {
  const qc = useQueryClient();
  const mutationKey = ["artifact-handoff", detail.id];
  const isPending = useIsMutating({ mutationKey }) > 0;
  const draftCount = useArtifactDraftCount(detail.id);
  const savingStatus = useFeedbackStatusPending(detail.id);
  const receipt = useFeedbackHandoffReceipt(detail.id, detail.feedback);
  const { copied: sent, flash: showSent } = useCopyFlash(3000);
  const [notice, setNotice] = useState("");
  const [deliveryLabel, setDeliveryLabel] = useState("Sent");
  const { data: watchers = [], isPending: loadingWatchers } = useQuery({
    queryKey: ["artifact-watchers", detail.id],
    queryFn: () => artifactApi.watchers(detail.id),
  });
  const pending = detail.feedback.filter(hasUnsentArtifactFeedback).length;
  const disabledReason =
    detail.state === "archived"
      ? "Restore the artifact to send feedback"
      : loadingWatchers
        ? "Checking for an agent"
        : !watchers.length
          ? null
          : savingStatus
            ? "Saving feedback status"
            : draftCount
              ? "Post or discard drafts before sending feedback"
              : !pending
                ? "No new feedback to send"
                : receipt.hashes === null
                  ? "Checking pending feedback"
                  : receipt.covered
                    ? "Already sent. Add or update feedback to send again."
                    : null;
  const mutation = useMutation({
    mutationKey,
    mutationFn: async () => {
      setNotice("");
      if (watchers.length) {
        const snapshot = receipt.begin();
        if (!snapshot) throw new Error("Pending feedback is still loading. Try again.");
        const result = await artifactApi.submit(detail.id);
        if (result.notification.state !== "sent" && result.notification.state !== "queued")
          throw new Error(
            result.notification.state === "failed"
              ? result.notification.error
              : "The agent notification was not delivered. Try again or run r3 feedback fetch.",
          );
        receipt.remember(snapshot);
        setDeliveryLabel(result.notification.state === "queued" ? "Queued" : "Sent");
        if (result.notification.state === "queued")
          setNotice(
            "Notification queued in Codex. It will be processed when the session can accept it.",
          );
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
        ? deliveryLabel
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
