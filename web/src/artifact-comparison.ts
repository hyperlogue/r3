import type {
  ArtifactDetail,
  ArtifactMediaTarget,
  ArtifactTarget,
  RenderedLocator,
} from "../../shared/artifacts.ts";
export type ElementComparisonTarget = {
  kind: "rendered";
  versionSeq: number;
  path: string;
  locator: RenderedLocator;
};
export type ComparisonTarget = ElementComparisonTarget | ArtifactMediaTarget;
export interface ArtifactComparison {
  threadId: string;
  commentId: string;
  original: ComparisonTarget;
  proposed: ComparisonTarget;
}
function elementTarget(target: ArtifactTarget | null): target is ComparisonTarget {
  return (
    (target?.kind === "rendered" && !!target.locator?.selector.trim()) ||
    (target?.kind === "media" && !!target.locator.frame)
  );
}
// Eligibility uses recorded native evidence, never comment context, placements, or
// the latest publication. Runtime availability is checked by each scoped preview.
export function artifactComparisons(detail: ArtifactDetail): Map<string, ArtifactComparison> {
  const versions = new Set(detail.versions.map((version) => version.seq));
  const comparisons = new Map<string, ArtifactComparison>();
  for (const threads of detail.threads) {
    const original = threads.target;
    if (!elementTarget(original) || !versions.has(original.versionSeq)) continue;
    for (const comment of threads.comments.slice(1)) {
      const proposed = comment.target;
      if (
        comment.author.role !== "agent" ||
        !elementTarget(proposed) ||
        proposed.kind !== original.kind ||
        !versions.has(proposed.versionSeq)
      )
        continue;
      comparisons.set(comment.id, {
        threadId: threads.id,
        commentId: comment.id,
        original,
        proposed,
      });
    }
  }
  return comparisons;
}
