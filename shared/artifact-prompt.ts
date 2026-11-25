import type {
  ArtifactComment,
  ArtifactDetail,
  ArtifactNudge,
  ArtifactTarget,
  ArtifactThread,
} from "./artifacts.ts";
import { type ArtifactAttachment, imagePlaceholder } from "./attachments.ts";
import { mediaTime, wholeMediaBox } from "./media-target.ts";

function captureText(image: ArtifactAttachment): string {
  const capture = image.capture;
  if (!capture) return "";
  const { viewport, crop } = capture;
  const full =
    crop.x === 0 &&
    crop.y === 0 &&
    crop.width === viewport.width &&
    crop.height === viewport.height;
  return ` · captured v${capture.versionSeq} ${capture.path}${capture.route ?? ""} at ${viewport.width}×${viewport.height}${full ? "" : ` crop ${crop.x},${crop.y} ${crop.width}×${crop.height}`}`;
}
export function attachmentPrompt(images: ArtifactAttachment[] = [], placeholders = true): string {
  return images
    .map(
      (image, index) =>
        `${placeholders ? `${imagePlaceholder(index + 1)} ` : ""}image ${image.id} · ${image.mediaType.slice(6)} ${image.width}×${image.height}${captureText(image)}`,
    )
    .join("\n");
}
export function commentAttachments(
  threads: ArtifactThread[],
  unsent = false,
): ArtifactAttachment[] {
  const frames = (target: ArtifactTarget | null) =>
    target?.kind === "media" && target.locator.frame ? [target.locator.frame] : [];
  return threads.flatMap((item) => {
    const followup =
      unsent && !(item.comments[0]!.author.role === "human" && item.comments[0]!.sentAt === null);
    return [
      ...frames(item.target),
      ...frames(item.anchor?.target ?? null),
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
  if (target.kind === "artifact") return "General artifact";
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
function historicalTarget(thread: ArtifactThread): boolean {
  const source = thread.comments[0]!.legacy?.source as
    | {
        file?: unknown;
      }
    | undefined;
  return (
    thread.target.kind === "artifact" && typeof source?.file === "string" && source.file !== ""
  );
}
export function artifactThreadTargetLabel(thread: ArtifactThread): string {
  return historicalTarget(thread)
    ? "Historical target unavailable"
    : artifactTargetLabel(thread.target);
}
// The label already carries kind, version, path, line range, side and media
// time; only matching evidence the label cannot show remains.
function locatorText(target: ArtifactTarget): string {
  if (!("locator" in target) || !target.locator) return "";
  const evidence: Record<string, unknown> = {};
  if (target.kind === "media") {
    if (!wholeMediaBox(target.locator.box)) evidence.box = target.locator.box;
  } else if (target.kind === "rendered") {
    const { selector, shadowHosts, label, quote, route } = target.locator;
    Object.assign(evidence, { selector, shadowHosts, label, quote, route });
  } else if ("quote" in target.locator) evidence.quote = target.locator.quote;
  const json = JSON.stringify(evidence);
  return json === "{}" ? "" : ` ${json}`;
}
function targetText(target: ArtifactTarget): string {
  return `${artifactTargetLabel(target)}${locatorText(target)}`;
}
function sameContext(thread: ArtifactThread, comment: ArtifactComment): boolean {
  const target = thread.anchor?.target ?? thread.target;
  return (
    "versionSeq" in target &&
    comment.context.versionSeq === target.versionSeq &&
    comment.context.representation === target.kind
  );
}
function block(thread: ArtifactThread, unsent: boolean): string {
  const fresh = thread.comments[0]!.author.role === "human" && thread.comments[0]!.sentAt === null;
  const followup = unsent && !fresh;
  const author =
    thread.comments[0]!.author.role === "agent"
      ? ` [agent-authored: ${thread.comments[0]!.author.sessionId}]`
      : "";
  const lines = [
    `### ${thread.id} — ${artifactThreadTargetLabel(thread)} [${thread.status}]${author}${followup ? " (follow-up)" : ""}`,
  ];
  if (historicalTarget(thread)) {
    const evidence = thread.comments[0]!.legacy!.source as Record<string, unknown>;
    lines.push(
      `Legacy anchor evidence: ${JSON.stringify({ file: evidence.file, side: evidence.side, lineStart: evidence.line_start, lineEnd: evidence.line_end, quote: evidence.quote, patchSeq: evidence.patch_seq })}`,
    );
  } else {
    const locator = locatorText(thread.target).trim();
    if (locator) lines.push(`Locator: ${locator}`);
  }
  if (thread.anchor)
    lines.push(
      `Moved to (anchor revision ${thread.anchor.revision}): ${targetText(thread.anchor.target)}`,
    );
  if (thread.target.kind === "media" && thread.target.locator.frame)
    lines.push(`Frame (authoritative): ${attachmentPrompt([thread.target.locator.frame], false)}`);
  if (thread.claim) lines.push(`Working agent: ${thread.claim.sessionId}`);
  if (!followup) {
    lines.push("", thread.comments[0]!.body);
    if (thread.comments[0]!.attachments?.length)
      lines.push(attachmentPrompt(thread.comments[0]!.attachments));
  }
  const comments = followup
    ? thread.comments
        .slice(1)
        .filter((comment) => comment.author.role === "human" && comment.sentAt === null)
    : thread.comments.slice(1);
  for (const comment of comments) {
    const author = comment.author.role === "agent" ? `agent: ${comment.author.sessionId}` : "human";
    lines.push("", `[${author}] ${comment.body}`);
    if (comment.attachments?.length) lines.push(attachmentPrompt(comment.attachments));
    if (!comment.target && comment.context.versionSeq !== null && !sameContext(thread, comment))
      lines.push(
        `Viewing: Version ${comment.context.versionSeq} · ${comment.context.representation}`,
      );
    if (comment.target) lines.push(`Fix: ${targetText(comment.target)}`);
    if (comment.target?.kind === "media" && comment.target.locator.frame)
      lines.push(`Fix frame: ${attachmentPrompt([comment.target.locator.frame], false)}`);
  }
  if (thread.statusUnsent)
    lines.push(
      "",
      thread.status === "resolved"
        ? "The human marked this resolved; no further action is requested."
        : "The human reopened this thread.",
    );
  return lines.join("\n");
}
// The caller selects a read-only set or the exact snapshot returned by deliver().
// Formatting is pure and cannot acknowledge messages accidentally.
export function buildArtifactPrompt(
  detail: ArtifactDetail,
  threads: ArtifactThread[],
  unsent = false,
  comments: ArtifactComment[] = [],
): string {
  const latest = detail.versions.at(-1)?.seq;
  const lines = [
    `Artifact ${detail.id}${detail.title ? ` — ${detail.title}` : ""} (${detail.kind}, ${detail.state}, latest ${latest === undefined ? "none" : `v${latest}`}) · ${threads.length} thread${threads.length === 1 ? "" : "s"}`,
    "",
  ];
  if (!threads.length) lines.push(unsent ? "No undelivered threads." : "No selected threads.");
  else lines.push(threads.map((item) => block(item, unsent)).join("\n\n"));
  if (comments.length) {
    lines.push("", "## Artifact comments");
    for (const comment of comments) lines.push("", `### ${comment.id}`, comment.body);
  }
  const notes = [];
  if (
    threads.some(
      (item) =>
        (item.target.kind === "source" || item.target.kind === "diff") && item.target.locator,
    )
  )
    notes.push("Quotes may be excerpts. Full captured lines: r3 thread source <thread-id>");
  if (
    unsent &&
    threads.some(
      (item) => !(item.comments[0]!.author.role === "human" && item.comments[0]!.sentAt === null),
    )
  )
    notes.push(`Earlier messages: r3 show ${detail.id}`);
  if (commentAttachments(threads, unsent).length)
    notes.push(
      `Download an image: r3 comment image ${detail.id} --image <image-id> --output <file>`,
    );
  if (notes.length) lines.push("", "---", ...notes);
  return `${lines.join("\n")}\n`;
}
export function artifactNudgeText(nudge: ArtifactNudge): string {
  const lines = [
    `[r3] ${nudge.artifactId} — ${nudge.event === "archived" ? "archived" : "comments submitted"}`,
  ];
  if (nudge.event === "archived" && nudge.versionSeq !== undefined)
    lines[0] += ` at v${nudge.versionSeq}`;
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
