import type {
  ArtifactDetail,
  ArtifactFeedback,
  ArtifactNudge,
  ArtifactTarget,
} from "./artifacts.ts";

export function artifactTargetLabel(target: ArtifactTarget): string {
  if (target.kind === "artifact") return "General artifact feedback";
  if (target.kind === "artifact_summary") return "Artifact summary";
  if (target.kind === "version_summary") return `Version ${target.versionSeq} summary`;
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
  if (feedback.claim) lines.push(`Working agent: ${feedback.claim.sessionId}`);
  if (!followup) lines.push("", feedback.body);
  const replies = followup
    ? feedback.replies.filter((reply) => reply.author.role === "human" && reply.sentAt === null)
    : feedback.replies;
  for (const reply of replies) {
    const author = reply.author.role === "agent" ? `agent: ${reply.author.sessionId}` : "human";
    lines.push("", `[${author}] ${reply.body}`);
    if (reply.context.versionSeq !== null)
      lines.push(`Message context: ${JSON.stringify(reply.context)}`);
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
  if (detail.summary) lines.push("Artifact summary:", detail.summary, "");
  if (detail.state === "archived") {
    lines.push(
      "This artifact is archived. Publication, new claims, and ordinary handoff are paused. Saved threads and in-flight replies remain available.",
      "",
    );
  } else {
    lines.push(
      "Use stable feedback IDs. Claim the open items you will handle with r3 claim <feedback_id> [<feedback_id> ...]. Other agents may work on this artifact under their own distinct sessions.",
      "Inspect each original target in its explicit version and representation. Rendered element evidence is native to the page; do not invent a source-line mapping. Record additional verified placements separately.",
      detail.kind === "diff"
        ? `Publish a new independent patch with: git diff <base> <head> | r3 publish ${detail.id} --stdin-diff`
        : `Publish the complete updated directory with: r3 publish ${detail.id} --dir <prepared-directory>`,
      "Reply by feedback ID with r3 reply <feedback_id> -m <message>. Supply --version <seq> and --view <source|rendered|diff> when the reply refers to a published representation. A later fix target is separate from this message context.",
      "Publishing and replying do not resolve feedback. The human controls open/resolved status. A successful agent reply releases only that agent's own claim.",
      `Use r3 show ${detail.id} for full history and r3 guide for command syntax.`,
      "",
    );
  }
  if (!feedback.length) lines.push(unsent ? "No undelivered feedback." : "No selected feedback.");
  else lines.push(feedback.map((item) => block(item, unsent)).join("\n\n"));
  return `${lines.join("\n")}\n`;
}

export function artifactNudgeText(nudge: ArtifactNudge): string {
  const lines = [
    `[r3] ${nudge.artifactId} — ${nudge.event === "archived" ? "archived" : "feedback submitted"}`,
  ];
  if (nudge.title) lines.push(`Artifact: ${nudge.title.slice(0, 500)}`);
  if (nudge.event === "submitted") lines.push(`Run: r3 prompt ${nudge.artifactId}`);
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
