import type { ArtifactFeedback } from "../../shared/artifacts.ts";

import { isUnhandledArtifactFeedback as artifactNeedsAttention } from "../../shared/artifacts.ts";

export { artifactNeedsAttention };

// New notes stay where their composer was. Replies and claims do not reorder
// existing conversations. Reverse input order breaks equal creation-time ties
// using the server's oldest-first order, without sorting random IDs.
export function activeArtifactFeedback(feedback: ArtifactFeedback[]): ArtifactFeedback[] {
  return feedback
    .filter((note) => note.status === "open")
    .reverse()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
