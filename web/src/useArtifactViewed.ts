import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useArtifactClient } from "./artifact-ui-context.tsx";
export function useArtifactViewed(id: string) {
  const artifactApi = useArtifactClient();
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
