import {
  useIsMutating,
  useMutation,
  useMutationState,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import {
  type ArtifactDetail,
  type ArtifactFeedback,
  isUnhandledArtifactFeedback,
} from "../../shared/artifacts.ts";
import { artifactApi } from "./artifact-api.ts";

type StatusChange = { feedbackId: string; status: ArtifactFeedback["status"] };
const statusKey = (artifactId: string) => ["feedback-status", artifactId];

export function useFeedbackStatusPending(artifactId: string): boolean {
  return useIsMutating({ mutationKey: statusKey(artifactId) }) > 0;
}

// Pending human decisions are a presentation layer over the latest server data.
// Refetches can still bring in replies and other agents' work without undoing a
// pending click. Failed mutations simply reveal that latest authoritative state.
export function useOptimisticArtifact(detail: ArtifactDetail): ArtifactDetail {
  const pending = useMutationState<StatusChange>({
    filters: { mutationKey: statusKey(detail.id), status: "pending" },
    select: (mutation) => mutation.state.variables as StatusChange,
  });
  return useMemo(() => {
    if (!pending.length) return detail;
    const statuses = new Map(pending.map((change) => [change.feedbackId, change.status]));
    let changed = false;
    const feedback = detail.feedback.map((note) => {
      const status = statuses.get(note.id);
      if (!status || status === note.status) return note;
      changed = true;
      return {
        ...note,
        status,
        statusUnsent: note.statusUnsent || note.sentAt !== null,
        claim: status === "resolved" ? null : note.claim,
      };
    });
    return changed
      ? { ...detail, feedback, unhandledCount: feedback.filter(isUnhandledArtifactFeedback).length }
      : detail;
  }, [detail, pending]);
}

export function useFeedbackStatus(feedback: ArtifactFeedback) {
  const qc = useQueryClient();
  const key = [...statusKey(feedback.artifactId), feedback.id];
  const mutations = useMutationState({
    filters: { mutationKey: key, exact: true },
    select: (mutation) => ({ status: mutation.state.status, error: mutation.state.error }),
  });
  const latest = mutations.at(-1);
  const mutation = useMutation({
    mutationKey: key,
    mutationFn: (change: StatusChange) =>
      artifactApi.editFeedback(change.feedbackId, { status: change.status }),
    onSuccess: (saved) => {
      // Patch only status-owned fields. A concurrent reply or body edit may be
      // newer than this mutation's response and must survive its completion.
      qc.setQueryData<ArtifactDetail>(["artifact", feedback.artifactId], (current) => {
        if (!current) return current;
        const notes = current.feedback.map((note) =>
          note.id === saved.id
            ? {
                ...note,
                status: saved.status,
                statusUnsent: saved.statusUnsent,
                claim: saved.claim,
                updatedAt: note.updatedAt > saved.updatedAt ? note.updatedAt : saved.updatedAt,
              }
            : note,
        );
        return {
          ...current,
          feedback: notes,
          unhandledCount: notes.filter(isUnhandledArtifactFeedback).length,
        };
      });
    },
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["artifact", feedback.artifactId] }),
        qc.invalidateQueries({ queryKey: ["artifacts"] }),
      ]),
  });
  return {
    isPending: latest?.status === "pending",
    error: latest?.status === "error" ? latest.error : null,
    change: (status: ArtifactFeedback["status"]) => {
      if (!qc.isMutating({ mutationKey: key, exact: true }))
        mutation.mutate({ feedbackId: feedback.id, status });
    },
  };
}
