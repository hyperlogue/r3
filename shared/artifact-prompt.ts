import type {
  ArtifactComment,
  ArtifactDetail,
  ArtifactDiscussion,
  ArtifactNudge,
  ArtifactTarget,
} from "./artifacts.ts";
import { type ArtifactAttachment, imagePlaceholder } from "./attachments.ts";
import { mediaTime, wholeMediaBox } from "./media-target.ts";
export function attachmentPrompt(images: ArtifactAttachment[] = [], placeholders = true): string {
  return images
    .map(
      (image, index) =>
        `${placeholders ? `${imagePlaceholder(index + 1)} ` : ""}Image ${image.id} (${image.mediaType}, ${image.width}×${image.height}, ${image.byteLength} bytes)${image.capture ? `\nCapture context: ${JSON.stringify(image.capture)}` : ""}\nDownload: r3 discussions image ${image.artifactId} --image ${image.id} --output ${image.id}.${image.mediaType === "image/png" ? "png" : "jpg"}`,
    )
    .join("\n");
}
export function discussionAttachments(
  discussions: ArtifactDiscussion[],
  unsent = false,
): ArtifactAttachment[] {
  const frames = (target: ArtifactTarget | null) =>
    target?.kind === "media" && target.locator.frame ? [target.locator.frame] : [];
  return discussions.flatMap((item) => {
    const followup =
      unsent && !(item.comments[0]!.author.role === "human" && item.comments[0]!.sentAt === null);
    return [
      ...frames(item.target),
      ...(followup ? [] : (item.comments[0]!.attachments ?? [])),
      ...item.comments
        .slice(1)
        .filter(
          (comment) => !followup || (comment.author.role === "human" && comment.sentAt === null),
        )
        .flatMap((comment) => [...(comment.attachments ?? []), ...frames(comment.target)]),
    ];
  });
}
export function artifactTargetLabel(target: ArtifactTarget): string {
  if (target.kind === "artifact") return "General artifact discussions";
  if (target.kind === "artifact_summary") return "Retired artifact overview";
  if (target.kind === "version_summary") return `Version ${target.versionSeq} summary`;
  if (target.kind === "media")
    return `Version ${target.versionSeq} · ${target.path}${target.locator.time === null ? "" : ` · ${mediaTime(target.locator.time)}`} · ${wholeMediaBox(target.locator.box) ? "Full frame" : "Region"}`;
  const range =
    target.locator && "start" in target.locator
      ? `:${target.locator.start}-${target.locator.end}${"side" in target.locator ? ` (${target.locator.side})` : ""}`
      : "";
  return `Version ${target.versionSeq} · ${target.kind} · ${target.path}${range}`;
}
function historicalTarget(discussions: ArtifactDiscussion): boolean {
  const source = discussions.comments[0]!.legacy?.source as
    | {
        file?: unknown;
      }
    | undefined;
  return (
    discussions.target.kind === "artifact" && typeof source?.file === "string" && source.file !== ""
  );
}
export function artifactDiscussionTargetLabel(discussions: ArtifactDiscussion): string {
  return historicalTarget(discussions)
    ? "Historical target unavailable"
    : artifactTargetLabel(discussions.target);
}
function block(discussions: ArtifactDiscussion, unsent: boolean): string {
  const fresh =
    discussions.comments[0]!.author.role === "human" && discussions.comments[0]!.sentAt === null;
  const followup = unsent && !fresh;
  const label = artifactDiscussionTargetLabel(discussions);
  const author =
    discussions.comments[0]!.author.role === "agent"
      ? ` [agent-authored: ${discussions.comments[0]!.author.sessionId}]`
      : "";
  const lines = [
    `### ${discussions.id} — ${label} [${discussions.status}]${author}${followup ? " (follow-up)" : ""}`,
  ];
  if (historicalTarget(discussions)) {
    const evidence = discussions.comments[0]!.legacy!.source as Record<string, unknown>;
    lines.push(
      `Legacy anchor evidence: ${JSON.stringify({ file: evidence.file, side: evidence.side, lineStart: evidence.line_start, lineEnd: evidence.line_end, quote: evidence.quote, patchSeq: evidence.patch_seq })}`,
    );
  } else lines.push(`Original target: ${JSON.stringify(discussions.target)}`);
  if (
    (discussions.target.kind === "source" || discussions.target.kind === "diff") &&
    discussions.target.locator
  )
    lines.push(`Full captured range: r3 discussions source ${discussions.id}`);
  if (discussions.target.kind === "media" && discussions.target.locator.frame)
    lines.push(
      "Saved full frame (authoritative; video seeking is approximate):",
      attachmentPrompt([discussions.target.locator.frame], false),
    );
  if (discussions.claim) lines.push(`Working agent: ${discussions.claim.sessionId}`);
  if (!followup) {
    lines.push("", discussions.comments[0]!.body);
    if (discussions.comments[0]!.attachments?.length)
      lines.push(attachmentPrompt(discussions.comments[0]!.attachments));
  }
  const comments = followup
    ? discussions.comments
        .slice(1)
        .filter((comment) => comment.author.role === "human" && comment.sentAt === null)
    : discussions.comments.slice(1);
  for (const comment of comments) {
    const author = comment.author.role === "agent" ? `agent: ${comment.author.sessionId}` : "human";
    lines.push("", `[${author}] ${comment.body}`);
    if (comment.attachments?.length) lines.push(attachmentPrompt(comment.attachments));
    if (comment.context.versionSeq !== null)
      lines.push(`Reference context: ${JSON.stringify(comment.context)}`);
    if (comment.target?.kind === "media" && comment.target.locator.frame)
      lines.push("Saved fix frame:", attachmentPrompt([comment.target.locator.frame], false));
    if (comment.target) lines.push(`Fix target: ${JSON.stringify(comment.target)}`);
  }
  if (discussions.statusUnsent)
    lines.push(
      "",
      discussions.status === "resolved"
        ? "The human marked this resolved; no further action is requested."
        : "The human reopened this discussion.",
    );
  if (followup) lines.push("", `Earlier discussion: r3 show ${discussions.artifactId}`);
  return lines.join("\n");
}
// The caller selects a read-only set or the exact snapshot returned by deliver().
// Formatting is pure and cannot acknowledge messages accidentally.
export function buildArtifactPrompt(
  detail: ArtifactDetail,
  discussions: ArtifactDiscussion[],
  unsent = false,
  comments: ArtifactComment[] = [],
): string {
  const latest = detail.versions.at(-1)?.seq;
  const lines = [
    `Artifact ${detail.id}${detail.title ? ` — ${detail.title}` : ""}`,
    `Kind: ${detail.kind}. State: ${detail.state}. Latest published version: ${latest ?? "none"}.`,
    `${discussions.length} discussion${discussions.length === 1 ? "" : "s"}.`,
    "",
  ];
  if (!discussions.length)
    lines.push(unsent ? "No undelivered discussions." : "No selected discussions.");
  else lines.push(discussions.map((item) => block(item, unsent)).join("\n\n"));
  if (comments.length) {
    lines.push("", "## Artifact comments");
    for (const comment of comments) lines.push("", `### ${comment.id}`, comment.body);
  }
  return `${lines.join("\n")}\n`;
}
export function artifactNudgeText(nudge: ArtifactNudge): string {
  const lines = [
    `[r3] ${nudge.artifactId} — ${nudge.event === "archived" ? "archived" : "comments submitted"}`,
  ];
  if (nudge.title) lines.push(`Artifact: ${nudge.title.slice(0, 500)}`);
  if (nudge.event === "submitted") lines.push(`Run: r3 comment fetch ${nudge.artifactId}`);
  else {
    if (nudge.lifecycleEventId) lines.push(`Event: ${nudge.lifecycleEventId}`);
    if (nudge.comment) {
      // Wake adapters may carry this text as one process argument. The complete
      // message remains in the lifecycle history; keep the nudge bounded.
      lines.push("", "Comment:", nudge.comment.body.slice(0, 8000));
      if (nudge.comment.truncated || nudge.comment.body.length > 8000)
        lines.push(`… Read the complete Comment: r3 comment show ${nudge.comment.id}`);
    }
  }
  return lines.join("\n");
}
