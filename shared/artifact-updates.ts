import type {
  Artifact,
  ArtifactClaim,
  ArtifactDetail,
  ArtifactThread,
  ArtifactWatcher,
} from "./artifacts.ts";
import { artifactAgentIds } from "./artifacts.ts";

export interface ArtifactDelta {
  delta: true;
  baseCursor: string;
  syncCursor: string;
  artifact: Artifact;
  threads: ArtifactThread[];
  removedThreadIds: string[];
  claims: ArtifactClaim[];
  watchers: ArtifactWatcher[];
  agentLabels: Record<string, string | null>;
}
export type ArtifactUpdate = ArtifactDetail | ArtifactDelta;

// Reject stale responses and deltas for a different base. A caller can recover
// from a missing base by requesting a full snapshot without a cursor.
export function mergeArtifactUpdate(
  current: ArtifactDetail | undefined,
  update: ArtifactUpdate,
): ArtifactDetail {
  if (!("delta" in update)) return update;
  if (!current || current.id !== update.artifact.id)
    throw new Error("Artifact update needs its snapshot");
  if (current.syncCursor !== update.baseCursor) throw new Error("Artifact update has a stale base");
  const removed = new Set(update.removedThreadIds);
  const changed = new Map(update.threads.map((thread) => [thread.id, thread]));
  const claims = new Map(update.claims.map((claim) => [claim.threadId, claim]));
  const threads = current.threads
    .filter((thread) => !removed.has(thread.id))
    .map((thread) => {
      const next = changed.get(thread.id) ?? thread;
      changed.delete(thread.id);
      return { ...next, claim: claims.get(next.id) ?? null };
    });
  threads.push(...changed.values());
  const next = {
    ...current,
    ...update.artifact,
    syncCursor: update.syncCursor,
    threads,
    agentLabels: { ...current.agentLabels, ...update.agentLabels },
  };
  next.agentLabels = Object.fromEntries(
    artifactAgentIds(next).map((id) => [id, next.agentLabels[id] ?? null]),
  );
  return next;
}
