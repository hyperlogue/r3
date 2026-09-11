import { describe, expect, test } from "bun:test";
import { artifactNudgeText, buildArtifactPrompt } from "./artifact-prompt.ts";
import type { ArtifactDetail, ArtifactFeedback } from "./artifacts.ts";

const time = "2026-09-01T00:00:00.000Z";
const human = { role: "human" as const, sessionId: null };
const detail: ArtifactDetail = {
  id: "artifact_example",
  kind: "files",
  state: "active",
  title: "Published design",
  summary: null,
  projectId: null,
  meta: {},
  createdBy: human,
  nextSeq: 1,
  createdAt: time,
  updatedAt: time,
  archivedAt: null,
  watching: false,
  working: false,
  legacy: null,
  versions: [],
  feedback: [],
  placements: [],
  events: [],
};
function note(): ArtifactFeedback {
  return {
    id: "feedback_example",
    artifactId: detail.id,
    author: human,
    body: "Please change the title",
    status: "open",
    target: {
      kind: "rendered",
      versionSeq: 2,
      path: "index.md",
      locator: {
        selector: "h1",
        quote: "Original title",
        route: "#overview",
        viewport: { width: 1000, height: 800 },
      },
    },
    legacy: null,
    createdAt: time,
    updatedAt: time,
    sentAt: null,
    statusUnsent: false,
    replies: [],
    claim: null,
  };
}

describe("artifact prompt formatting", () => {
  test("preserves native version, representation and rendered evidence without changing delivery state", () => {
    const feedback = note();
    const prompt = buildArtifactPrompt(detail, [feedback], true);
    expect(prompt).toContain("Version 2 · rendered · index.md");
    expect(prompt).toContain('"selector":"h1"');
    expect(prompt).toContain('"route":"#overview"');
    expect(prompt).toContain("Please change the title");
    expect(prompt).toContain("The human controls open/resolved status");
    expect(feedback.sentAt).toBeNull();
  });

  test("follow-ups include only newly delivered human messages and explicit status changes", () => {
    const feedback = note();
    feedback.sentAt = time;
    feedback.status = "resolved";
    feedback.statusUnsent = true;
    feedback.replies = [
      {
        id: "reply_old",
        artifactId: detail.id,
        feedbackId: feedback.id,
        author: { role: "agent", sessionId: "previous-agent" },
        body: "Already delivered answer",
        context: { versionSeq: 2, representation: "rendered" },
        target: null,
        createdAt: time,
        sentAt: time,
        legacy: null,
      },
      {
        id: "reply_new",
        artifactId: detail.id,
        feedbackId: feedback.id,
        author: human,
        body: "New owner response",
        context: { versionSeq: 2, representation: "rendered" },
        target: null,
        createdAt: time,
        sentAt: null,
        legacy: null,
      },
    ];
    const prompt = buildArtifactPrompt(detail, [feedback], true);
    expect(prompt).toContain("(follow-up)");
    expect(prompt).toContain("New owner response");
    expect(prompt).not.toContain("Already delivered answer");
    expect(prompt).toContain("The human marked this resolved");
    expect(buildArtifactPrompt(detail, [feedback])).toContain("Already delivered answer");
  });

  test("uncertain imported targets remain historical evidence and archived nudges imply no approval", () => {
    const feedback = note();
    feedback.target = { kind: "artifact" };
    feedback.legacy = { source: { file: "notes.md", quote: "Original title", line_start: 3 } };
    const prompt = buildArtifactPrompt({ ...detail, state: "archived", archivedAt: time }, [
      feedback,
    ]);
    expect(prompt).toContain("Historical target unavailable");
    expect(prompt).toContain('"file":"notes.md"');
    expect(prompt).not.toContain("General artifact feedback");
    expect(prompt).not.toContain("Publish the complete updated directory");
    const nudge = artifactNudgeText({
      id: "nudge_example",
      artifactId: detail.id,
      title: detail.title,
      event: "archived",
      lifecycleEventId: "event_example",
      message: "Continue with the implementation",
    });
    expect(nudge).toContain("archived");
    expect(nudge).toContain("Continue with the implementation");
    expect(nudge).not.toContain("approved");
    expect(nudge).not.toContain("Run: r3 prompt");
  });
});
