import type { ArtifactFeedback } from "../../shared/artifacts.ts";

import { isUnhandledArtifactFeedback as artifactNeedsAttention } from "../../shared/artifacts.ts";

export { artifactNeedsAttention };

// Keep freshly posted notes beside the composer until handed off. A human reply
// yields to threads that still need attention, even while that reply is unsent.
function attentionRank(note: ArtifactFeedback): number {
  if (
    note.author.role === "human" &&
    note.sentAt === null &&
    note.replies.length === 0 &&
    !note.claim
  )
    return 0;
  if (artifactNeedsAttention(note)) return 1;
  return note.claim ? 3 : 2;
}

// Newest first within each group; reverse server insertion order breaks equal
// creation-time ties without sorting random IDs or mutating the input.
export function activeArtifactFeedback(feedback: ArtifactFeedback[]): ArtifactFeedback[] {
  return feedback
    .filter((note) => note.status === "open")
    .reverse()
    .sort((a, b) => attentionRank(a) - attentionRank(b) || b.createdAt.localeCompare(a.createdAt));
}
