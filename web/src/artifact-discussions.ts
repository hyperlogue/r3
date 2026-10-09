import type {
  ArtifactComment,
  ArtifactDetail,
  ArtifactDiscussion,
} from "../../shared/artifacts.ts";
import { isUnhandledArtifactDiscussion as artifactNeedsAttention } from "../../shared/artifacts.ts";

export { artifactNeedsAttention };
export function withSavedComment(detail: ArtifactDetail, comment: ArtifactComment): ArtifactDetail {
  let changed = false;
  const discussions = detail.discussions.map((note) => {
    // A refetch may already include this comment with a newer edit or delivery stamp.
    if (
      note.id !== comment.discussionId ||
      note.comments.slice(1).some((saved) => saved.id === comment.id)
    )
      return note;
    changed = true;
    return {
      ...note,
      comments: [
        {
          ...note.comments[0]!,
        },
        ...[...note.comments.slice(1), comment].sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        ),
      ],
    };
  });
  return changed
    ? { ...detail, discussions, unhandledCount: discussions.filter(artifactNeedsAttention).length }
    : detail;
}
// Keep freshly posted notes beside the composer until handed off. A human comment
// yields to threads that still need attention, even while that comment is unsent.
function attentionRank(note: ArtifactDiscussion): number {
  if (
    note.comments[0]!.author.role === "human" &&
    note.comments[0]!.sentAt === null &&
    note.comments.slice(1).length === 0 &&
    !note.claim
  )
    return 0;
  if (artifactNeedsAttention(note)) return 1;
  return note.claim ? 3 : 2;
}
// Newest first within each group; reverse server insertion order breaks equal
// creation-time ties without sorting random IDs or mutating the input.
export function activeArtifactDiscussion(discussions: ArtifactDiscussion[]): ArtifactDiscussion[] {
  return discussions
    .filter((note) => note.status === "open")
    .reverse()
    .sort((a, b) => attentionRank(a) - attentionRank(b) || b.createdAt.localeCompare(a.createdAt));
}
