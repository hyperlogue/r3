import type { ArtifactDetail, ArtifactTarget, RenderedLocator } from "../../shared/artifacts.ts";

export type ComparisonTarget = {
  kind: "rendered";
  versionSeq: number;
  path: string;
  locator: RenderedLocator;
};

export interface ArtifactComparison {
  feedbackId: string;
  replyId: string;
  original: ComparisonTarget;
  proposed: ComparisonTarget;
}

function elementTarget(target: ArtifactTarget | null): target is ComparisonTarget {
  return target?.kind === "rendered" && !!target.locator?.selector.trim();
}

// Eligibility uses recorded native evidence, never reply context, placements, or
// the latest publication. Runtime availability is checked by each scoped preview.
export function artifactComparisons(detail: ArtifactDetail): Map<string, ArtifactComparison> {
  const versions = new Set(detail.versions.map((version) => version.seq));
  const comparisons = new Map<string, ArtifactComparison>();
  for (const feedback of detail.feedback) {
    const original = feedback.target;
    if (!elementTarget(original) || !versions.has(original.versionSeq)) continue;
    for (const reply of feedback.replies) {
      const proposed = reply.target;
      if (
        reply.author.role !== "agent" ||
        !elementTarget(proposed) ||
        !versions.has(proposed.versionSeq)
      )
        continue;
      comparisons.set(reply.id, { feedbackId: feedback.id, replyId: reply.id, original, proposed });
    }
  }
  return comparisons;
}
