import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { artifactApi, artifactEventStream } from "./artifact-api.ts";
import { previewSessions } from "./preview-sessions.ts";

export function useArtifactEvents(): boolean {
  const queryClient = useQueryClient();
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", done);
          resolve();
        };
        timer = setTimeout(done, ms);
        controller.signal.addEventListener("abort", done, { once: true });
        if (controller.signal.aborted) done();
      });
    void (async () => {
      let delay = 500;
      while (!controller.signal.aborted) {
        try {
          for await (const event of artifactEventStream(controller.signal)) {
            if (controller.signal.aborted) break;
            setConnected(true);
            delay = 500;
            if (event.type === "ready") {
              for (const key of ["artifacts", "artifact", "artifact-watchers", "artifact-projects"])
                void queryClient.invalidateQueries({ queryKey: [key] });
            } else {
              if (event.type === "artifact-deleted") {
                previewSessions.forget(event.artifactId);
                for (const key of ["artifact-files", "artifact-source", "artifact-diff"])
                  queryClient.removeQueries({ queryKey: [key, event.artifactId] });
              }
              void queryClient.invalidateQueries({ queryKey: ["artifacts"] });
              void queryClient.invalidateQueries({ queryKey: ["artifact", event.artifactId] });
              if (event.type === "presence-changed" || event.type === "lifecycle")
                void queryClient.invalidateQueries({
                  queryKey: ["artifact-watchers", event.artifactId],
                });
            }
          }
        } catch {
          /* Reconnect and refetch; event streams carry invalidations only. */
        }
        if (controller.signal.aborted) break;
        setConnected(false);
        await wait(delay);
        delay = Math.min(8000, delay * 2);
      }
    })();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [queryClient]);
  return connected;
}

export function useArtifactViewed(id: string) {
  const qc = useQueryClient();
  const key = ["artifact-viewed", id];
  const { data: keys = [] } = useQuery({ queryKey: key, queryFn: () => artifactApi.viewed(id) });
  const mutation = useMutation({
    mutationFn: ({ key, viewed }: { key: string; viewed: boolean }) =>
      artifactApi.setViewed(id, key, viewed),
    onMutate: async ({ key: value, viewed }) => {
      await qc.cancelQueries({ queryKey: key });
      const previous = qc.getQueryData<string[]>(key);
      const next = new Set(previous);
      if (viewed) next.add(value);
      else next.delete(value);
      qc.setQueryData(key, [...next]);
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (context?.previous) qc.setQueryData(key, context.previous);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
  const isViewed = useCallback((key: string) => keys.includes(key), [keys]);
  const toggle = useCallback(
    (key: string) => {
      const current = qc.getQueryData<string[]>(["artifact-viewed", id]);
      mutation.mutate({ key, viewed: !current?.includes(key) });
    },
    [qc, id, mutation.mutate],
  );
  return { isViewed, toggle, error: mutation.error };
}
