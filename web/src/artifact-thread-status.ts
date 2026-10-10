import {
  useIsMutating,
  useMutation,
  useMutationState,
  useQueryClient,
} from "@tanstack/react-query";
import { useMemo } from "react";
import {
  type ArtifactDetail,
  type ArtifactThread,
  isUnhandledArtifactThread,
} from "../../shared/artifacts.ts";
import { useArtifactClient } from "./artifact-ui-context.tsx";

type StatusChange = {
  threadId: string;
  status: ArtifactThread["status"];
};
const statusKey = (artifactId: string) => ["threads-status", artifactId];
export function useThreadStatusPending(artifactId: string): boolean {
  return useIsMutating({ mutationKey: statusKey(artifactId) }) > 0;
}
// Pending human decisions are a presentation layer over the latest server data.
// Refetches can still bring in comments and other agents' work without undoing a
// pending click. Failed mutations simply reveal that latest authoritative state.
export function useOptimisticArtifact(detail: ArtifactDetail): ArtifactDetail {
  const pending = useMutationState<StatusChange>({
    filters: { mutationKey: statusKey(detail.id), status: "pending" },
    select: (mutation) => mutation.state.variables as StatusChange,
  });
  return useMemo(() => {
    if (!pending.length) return detail;
    const statuses = new Map(pending.map((change) => [change.threadId, change.status]));
    let changed = false;
    const threads = detail.threads.map((note) => {
      const status = statuses.get(note.id);
      if (!status || status === note.status) return note;
      changed = true;
      return {
        ...note,
        status,
        statusUnsent: note.statusUnsent || note.comments[0]!.sentAt !== null,
        claim: status === "resolved" ? null : note.claim,
      };
    });
    return changed
      ? {
          ...detail,
          threads,
          unhandledCount: threads.filter(isUnhandledArtifactThread).length,
        }
      : detail;
  }, [detail, pending]);
}
export function useThreadStatus(threads: ArtifactThread) {
  const artifactApi = useArtifactClient();
  const qc = useQueryClient();
  const key = [...statusKey(threads.artifactId), threads.id];
  const mutations = useMutationState({
    filters: { mutationKey: key, exact: true },
    select: (mutation) => ({ status: mutation.state.status, error: mutation.state.error }),
  });
  const latest = mutations.at(-1);
  const mutation = useMutation({
    mutationKey: key,
    mutationFn: (change: StatusChange) =>
      artifactApi.editThread(change.threadId, { status: change.status }),
    onSuccess: (saved) => {
      // Patch only status-owned fields. A concurrent comment or body edit may be
      // newer than this mutation's response and must survive its completion.
      qc.setQueryData<ArtifactDetail>(["artifact", threads.artifactId], (current) => {
        if (!current) return current;
        const notes = current.threads.map((note) =>
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
          threads: notes,
          unhandledCount: notes.filter(isUnhandledArtifactThread).length,
        };
      });
    },
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["artifact", threads.artifactId] }),
        qc.invalidateQueries({ queryKey: ["artifacts"] }),
      ]),
  });
  return {
    isPending: latest?.status === "pending",
    error: latest?.status === "error" ? latest.error : null,
    change: (status: ArtifactThread["status"]) => {
      if (!qc.isMutating({ mutationKey: key, exact: true }))
        mutation.mutate({ threadId: threads.id, status });
    },
  };
}
