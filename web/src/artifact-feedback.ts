import type { ArtifactFeedback } from "../../shared/artifacts.ts";

import { isUnhandledArtifactFeedback as artifactNeedsAttention } from "../../shared/artifacts.ts";

export { artifactNeedsAttention };

// Stable within each group: the human's next decisions first, then waiting
// notes, then work already claimed by an agent.
export function activeArtifactFeedback(feedback: ArtifactFeedback[]): ArtifactFeedback[] {
  return feedback
    .filter((note) => note.status === "open")
    .sort((a, b) => {
      const rank = (note: ArtifactFeedback) =>
        note.claim ? 2 : artifactNeedsAttention(note) ? 0 : 1;
      return rank(a) - rank(b);
    });
}
