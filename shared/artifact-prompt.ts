import type {
  ArtifactDetail,
  ArtifactFeedback,
  ArtifactNudge,
  ArtifactTarget,
} from "./artifacts.ts";
import { type ArtifactAttachment, imagePlaceholder } from "./attachments.ts";
import { mediaTime, wholeMediaBox } from "./media-target.ts";

export function attachmentPrompt(images: ArtifactAttachment[] = [], placeholders = true): string {
  return images
    .map(
      (image, index) =>
        `${placeholders ? `${imagePlaceholder(index + 1)} ` : ""}Image ${image.id} (${image.mediaType}, ${image.width}×${image.height}, ${image.byteLength} bytes)${image.capture ? `\nCapture context: ${JSON.stringify(image.capture)}` : ""}\nDownload: r3 feedback image ${image.artifactId} --image ${image.id} --output ${image.id}.${image.mediaType === "image/png" ? "png" : "jpg"}`,
    )
    .join("\n");
}

export function feedbackAttachments(
  feedback: ArtifactFeedback[],
  unsent = false,
): ArtifactAttachment[] {
  const frames = (target: ArtifactTarget | null) =>
    target?.kind === "media" && target.locator.frame ? [target.locator.frame] : [];
  return feedback.flatMap((item) => {
    const followup = unsent && !(item.author.role === "human" && item.sentAt === null);
    return [
      ...frames(item.target),
      ...(followup ? [] : (item.attachments ?? [])),
      ...item.replies
        .filter((reply) => !followup || (reply.author.role === "human" && reply.sentAt === null))
        .flatMap((reply) => [...(reply.attachments ?? []), ...frames(reply.target)]),
    ];
  });
}

export function artifactTargetLabel(target: ArtifactTarget): string {
  if (target.kind === "artifact") return "General artifact feedback";
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

function historicalTarget(feedback: ArtifactFeedback): boolean {
  const source = feedback.legacy?.source as { file?: unknown } | undefined;
  return (
    feedback.target.kind === "artifact" && typeof source?.file === "string" && source.file !== ""
  );
}

export function artifactFeedbackTargetLabel(feedback: ArtifactFeedback): string {
  return historicalTarget(feedback)
    ? "Historical target unavailable"
    : artifactTargetLabel(feedback.target);
}

function block(feedback: ArtifactFeedback, unsent: boolean): string {
  const fresh = feedback.author.role === "human" && feedback.sentAt === null;
  const followup = unsent && !fresh;
  const label = artifactFeedbackTargetLabel(feedback);
  const author =
    feedback.author.role === "agent" ? ` [agent-authored: ${feedback.author.sessionId}]` : "";
  const lines = [
    `### ${feedback.id} — ${label} [${feedback.status}]${author}${followup ? " (follow-up)" : ""}`,
  ];
  if (historicalTarget(feedback)) {
    const evidence = feedback.legacy!.source as Record<string, unknown>;
    lines.push(
      `Legacy anchor evidence: ${JSON.stringify({ file: evidence.file, side: evidence.side, lineStart: evidence.line_start, lineEnd: evidence.line_end, quote: evidence.quote, patchSeq: evidence.patch_seq })}`,
    );
  } else lines.push(`Original target: ${JSON.stringify(feedback.target)}`);
  if (
    (feedback.target.kind === "source" || feedback.target.kind === "diff") &&
    feedback.target.locator
  )
    lines.push(`Full captured range: r3 feedback source ${feedback.id}`);
  if (feedback.target.kind === "media" && feedback.target.locator.frame)
    lines.push(
      "Saved full frame (authoritative; video seeking is approximate):",
      attachmentPrompt([feedback.target.locator.frame], false),
    );
  if (feedback.claim) lines.push(`Working agent: ${feedback.claim.sessionId}`);
  if (!followup) {
    lines.push("", feedback.body);
    if (feedback.attachments?.length) lines.push(attachmentPrompt(feedback.attachments));
  }
  const replies = followup
    ? feedback.replies.filter((reply) => reply.author.role === "human" && reply.sentAt === null)
    : feedback.replies;
  for (const reply of replies) {
    const author = reply.author.role === "agent" ? `agent: ${reply.author.sessionId}` : "human";
    lines.push("", `[${author}] ${reply.body}`);
    if (reply.attachments?.length) lines.push(attachmentPrompt(reply.attachments));
    if (reply.context.versionSeq !== null)
      lines.push(`Reference context: ${JSON.stringify(reply.context)}`);
    if (reply.target?.kind === "media" && reply.target.locator.frame)
      lines.push("Saved fix frame:", attachmentPrompt([reply.target.locator.frame], false));
    if (reply.target) lines.push(`Fix target: ${JSON.stringify(reply.target)}`);
  }
  if (feedback.statusUnsent)
    lines.push(
      "",
      feedback.status === "resolved"
        ? "The human marked this resolved; no further action is requested."
        : "The human reopened this feedback.",
    );
  if (followup) lines.push("", `Earlier discussion: r3 show ${feedback.artifactId}`);
  return lines.join("\n");
}

// The caller selects a read-only set or the exact snapshot returned by deliver().
// Formatting is pure and cannot acknowledge messages accidentally.
export function buildArtifactPrompt(
  detail: ArtifactDetail,
  feedback: ArtifactFeedback[],
  unsent = false,
): string {
  const latest = detail.versions.at(-1)?.seq;
  const lines = [
    `Artifact ${detail.id}${detail.title ? ` — ${detail.title}` : ""}`,
    `Kind: ${detail.kind}. State: ${detail.state}. Latest published version: ${latest ?? "none"}.`,
    `${feedback.length} feedback item${feedback.length === 1 ? "" : "s"}.`,
    "",
  ];
  if (!feedback.length) lines.push(unsent ? "No undelivered feedback." : "No selected feedback.");
  else lines.push(feedback.map((item) => block(item, unsent)).join("\n\n"));
  return `${lines.join("\n")}\n`;
}

export function artifactNudgeText(nudge: ArtifactNudge): string {
  const lines = [
    `[r3] ${nudge.artifactId} — ${nudge.event === "archived" ? "archived" : "feedback submitted"}`,
  ];
  if (nudge.title) lines.push(`Artifact: ${nudge.title.slice(0, 500)}`);
  if (nudge.event === "submitted") lines.push(`Run: r3 feedback fetch ${nudge.artifactId}`);
  else {
    if (nudge.lifecycleEventId) lines.push(`Event: ${nudge.lifecycleEventId}`);
    if (nudge.message) {
      // Wake adapters may carry this text as one process argument. The complete
      // message remains in the lifecycle history; keep the nudge bounded.
      lines.push("", "Archive message:", nudge.message.slice(0, 8000));
      if (nudge.message.length > 8000)
        lines.push(`… Read the complete message: r3 show ${nudge.artifactId}`);
    }
  }
  return lines.join("\n");
}
