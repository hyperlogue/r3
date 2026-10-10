import { describe, expect, test } from "bun:test";
import { artifactNudgeText, buildArtifactPrompt } from "./artifact-prompt.ts";
import type { ArtifactDetail, ArtifactThread } from "./artifacts.ts";
import { artifactReferenceContext } from "./artifacts.ts";
import type { ArtifactAttachment } from "./attachments.ts";

const time = "2026-09-01T00:00:00.000Z";
const human = { role: "human" as const, sessionId: null };
const detail: ArtifactDetail = {
  id: "artifact_example",
  kind: "files",
  state: "active",
  title: "Published design",
  projectId: null,
  meta: {},
  createdBy: human,
  nextSeq: 1,
  createdAt: time,
  updatedAt: time,
  archivedAt: null,
  watching: false,
  working: false,
  unhandledCount: 0,
  storage: { totalBytes: 0, latestVersionBytes: 0 },
  legacy: null,
  versions: [],
  threads: [],
  placements: [],
  events: [],
};
function note(): ArtifactThread {
  return {
    id: "thread_example",
    artifactId: detail.id,
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
    createdAt: time,
    updatedAt: time,
    statusUnsent: false,
    claim: null,
    comments: [
      {
        id: "thread_example",
        threadId: "thread_example",
        artifactId: detail.id,
        createdAt: time,
        context: artifactReferenceContext({
          kind: "rendered",
          versionSeq: 2,
          path: "index.md",
          locator: {
            selector: "h1",
            quote: "Original title",
            route: "#overview",
            viewport: { width: 1000, height: 800 },
          },
        }),
        target: null,
        author: human,
        body: "Please change the title",
        sentAt: null,
        legacy: null,
      },
    ],
  };
}
describe("artifact prompt formatting", () => {
  test("image placeholders identify attachments within each note or comment", () => {
    const image = (id: string): ArtifactAttachment => ({
      id,
      artifactId: detail.id,
      hash: "0".repeat(64),
      mediaType: "image/png",
      byteLength: 100,
      width: 10,
      height: 10,
    });
    const threads = note();
    threads.comments[0]!.body = "Compare [image1] and [image2]";
    threads.comments[0]!.attachments = [image("first"), image("second")];
    threads.comments = [
      threads.comments[0]!,
      {
        id: "comment_images",
        artifactId: detail.id,
        threadId: threads.id,
        author: human,
        body: "Try [image1]",
        attachments: [image("comment_image")],
        context: { versionSeq: 2, representation: "rendered" },
        target: null,
        createdAt: time,
        sentAt: null,
        legacy: null,
      },
    ];
    const prompt = buildArtifactPrompt(detail, [threads]);
    expect(prompt).toContain("[image1] Image first");
    expect(prompt).toContain("[image2] Image second");
    expect(prompt).toContain("[image1] Image comment_image");
    expect(prompt).not.toContain("[image3]");
  });
  test("preserves native version, representation and rendered evidence without changing delivery state", () => {
    const threads = note();
    const prompt = buildArtifactPrompt(detail, [threads], true);
    expect(prompt).toContain("Version 2 · rendered · index.md");
    expect(prompt).toContain('"selector":"h1"');
    expect(prompt).toContain('"route":"#overview"');
    expect(prompt).toContain("Please change the title");
    expect(prompt).not.toContain("r3 claim");
    expect(prompt).not.toContain("r3 publish");
    expect(prompt).not.toContain("r3 comment");
    expect(threads.comments[0]!.sentAt).toBeNull();
  });
  test("follow-ups include only newly delivered human messages and explicit status changes", () => {
    const threads = note();
    threads.comments[0]!.sentAt = time;
    threads.status = "resolved";
    threads.statusUnsent = true;
    threads.comments = [
      threads.comments[0]!,
      {
        id: "comment_old",
        artifactId: detail.id,
        threadId: threads.id,
        author: { role: "agent", sessionId: "previous-agent" },
        body: "Already delivered answer",
        context: { versionSeq: 2, representation: "rendered" },
        target: null,
        createdAt: time,
        sentAt: time,
        legacy: null,
      },
      {
        id: "comment_new",
        artifactId: detail.id,
        threadId: threads.id,
        author: human,
        body: "New owner response",
        context: { versionSeq: 2, representation: "rendered" },
        target: null,
        createdAt: time,
        sentAt: null,
        legacy: null,
      },
    ];
    const prompt = buildArtifactPrompt(detail, [threads], true);
    expect(prompt).toContain("(follow-up)");
    expect(prompt).toContain("New owner response");
    expect(prompt).not.toContain("Already delivered answer");
    expect(prompt).toContain("The human marked this resolved");
    expect(prompt).toContain('Reference context: {"versionSeq":2,"representation":"rendered"}');
    expect(prompt).toContain(`Earlier thread: r3 show ${detail.id}`);
    expect(buildArtifactPrompt(detail, [threads])).toContain("Already delivered answer");
  });
  test("submission nudges use the preferred comment fetch command", () => {
    expect(
      artifactNudgeText({
        id: "nudge_example",
        artifactId: detail.id,
        title: detail.title,
        event: "submitted",
        lifecycleEventId: null,
        comment: null,
      }),
    ).toBe(
      `[r3] ${detail.id} — comments submitted\nArtifact: Published design\nRun: r3 comment fetch ${detail.id}`,
    );
  });
  test("uncertain imported targets remain historical evidence and archived nudges imply no approval", () => {
    const threads = note();
    threads.target = { kind: "artifact" };
    threads.comments[0]!.legacy = {
      source: { file: "notes.md", quote: "Original title", line_start: 3 },
    };
    const prompt = buildArtifactPrompt({ ...detail, state: "archived", archivedAt: time }, [
      threads,
    ]);
    expect(prompt).toContain("Historical target unavailable");
    expect(prompt).toContain('"file":"notes.md"');
    expect(prompt).not.toContain("General artifact");
    expect(prompt).not.toContain("Publish the complete updated directory");
    const nudge = artifactNudgeText({
      id: "nudge_example",
      artifactId: detail.id,
      title: detail.title,
      event: "archived",
      lifecycleEventId: "event_example",
      comment: {
        id: "comment_archive",
        body: "Continue with the implementation",
      },
    });
    expect(nudge).toContain("archived");
    expect(nudge).toContain("Continue with the implementation");
    expect(nudge).not.toContain("approved");
    expect(nudge).not.toContain("Run: r3 prompt");
    const large = artifactNudgeText({
      id: "nudge_large",
      artifactId: detail.id,
      title: null,
      event: "archived",
      lifecycleEventId: "event_large",
      comment: {
        id: "comment_archive",
        body: "More detail. ".repeat(100000),
      },
    });
    expect(large.length).toBeLessThan(9000);
    expect(large).toContain(`Read the complete Comment: r3 comment show comment_archive`);
  });
});
