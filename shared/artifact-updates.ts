import type {
  Artifact,
  ArtifactClaim,
  ArtifactDetail,
  ArtifactDiscussion,
  ArtifactWatcher,
} from "./artifacts.ts";
import { artifactAgentIds } from "./artifacts.ts";

export interface ArtifactDelta {
  delta: true;
  baseCursor: string;
  syncCursor: string;
  artifact: Artifact;
  discussions: ArtifactDiscussion[];
  removedDiscussionIds: string[];
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
  const removed = new Set(update.removedDiscussionIds);
  const changed = new Map(update.discussions.map((discussion) => [discussion.id, discussion]));
  const claims = new Map(update.claims.map((claim) => [claim.discussionId, claim]));
  const discussions = current.discussions
    .filter((discussion) => !removed.has(discussion.id))
    .map((discussion) => {
      const next = changed.get(discussion.id) ?? discussion;
      changed.delete(discussion.id);
      return { ...next, claim: claims.get(next.id) ?? null };
    });
  discussions.push(...changed.values());
  const next = {
    ...current,
    ...update.artifact,
    syncCursor: update.syncCursor,
    discussions,
    agentLabels: { ...current.agentLabels, ...update.agentLabels },
  };
  next.agentLabels = Object.fromEntries(
    artifactAgentIds(next).map((id) => [id, next.agentLabels[id] ?? null]),
  );
  return next;
}
