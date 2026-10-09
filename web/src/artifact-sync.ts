import type { QueryClient } from "@tanstack/react-query";
import { mergeArtifactUpdate } from "../../shared/artifact-updates.ts";
import type { Artifact, ArtifactDetail } from "../../shared/artifacts.ts";
import { artifactApi } from "./artifact-api.ts";

export function cacheArtifactSummary(qc: QueryClient, artifact: Artifact): void {
  qc.setQueryData<Artifact[]>(["artifacts"], (current) => {
    if (!current) return current;
    return current.some((item) => item.id === artifact.id)
      ? current.map((item) => (item.id === artifact.id ? artifact : item))
      : [...current, artifact];
  });
}
export async function readArtifactUpdate(
  qc: QueryClient,
  id: string,
  signal?: AbortSignal,
): Promise<ArtifactDetail> {
  const key = ["artifact", id];
  const before = qc.getQueryData<ArtifactDetail>(key);
  const update = await artifactApi.updates(id, before?.syncCursor, signal);
  const current = qc.getQueryData<ArtifactDetail>(key);
  // A mutation may have patched the cached object while this read was pending.
  // Query cancellation plus the base cursor prevents older data replacing a newer snapshot.
  if (signal?.aborted) throw signal.reason;
  if (current?.syncCursor !== before?.syncCursor) return current ?? artifactApi.detail(id);
  const next = mergeArtifactUpdate(current, update);
  cacheArtifactSummary(qc, "delta" in update ? update.artifact : next);
  if ("delta" in update) qc.setQueryData(["artifact-watchers", id], update.watchers);
  return next;
}
