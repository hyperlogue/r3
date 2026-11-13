import { expect, test } from "bun:test";
import type { ArtifactComment, ArtifactDetail, ArtifactThread } from "../../shared/artifacts.ts";
import type { PreviewPageContext } from "../../shared/preview-protocol.ts";
import { previewBridgeCall, previewLocator, previewSelectionPosition } from "./preview-bridge.ts";

test("rendered targets retain a bounded path through open shadow hosts", () => {
  const locator = { selector: "#button", shadowHosts: ["#phone", "#dialog"] };
  expect(previewLocator(locator)).toEqual(locator);
  for (const shadowHosts of [
    null,
    "#phone",
    [],
    [42],
    [" "],
    ["x".repeat(4097)],
    Array(17).fill("div"),
  ])
    expect(() => previewLocator({ ...locator, shadowHosts })).toThrow("shadowHosts");
});

test("rendered targets retain bounded ancestor evidence without introducing new scope", () => {
  const locator = {
    selector: "#button",
    shadowHosts: ["#phone", "#dialog"],
    ancestors: [
      { selector: "#form", shadowDepth: 2 },
      { selector: "#phone", shadowDepth: 0 },
    ],
  };
  expect(previewLocator(locator)).toEqual(locator);
  for (const ancestors of [
    null,
    [],
    ["#form"],
    [{ selector: "#form", shadowDepth: 3 }],
    [{ selector: "#form", shadowDepth: -1 }],
    [{ selector: "#form", shadowDepth: 0.5 }],
    [{ selector: "", shadowDepth: 0 }],
    [{ selector: "x".repeat(4097), shadowDepth: 0 }],
    [
      { selector: "#phone", shadowDepth: 0 },
      { selector: "#form", shadowDepth: 2 },
    ],
    Array(17).fill({ selector: "#form", shadowDepth: 0 }),
  ])
    expect(() => previewLocator({ ...locator, ancestors })).toThrow("ancestors");
});

test("full-height Markdown retains its native viewport evidence", () => {
  const locator = { selector: "h2", viewport: { width: 800, height: 200000 } };
  expect(previewLocator(locator)).toEqual(locator);
  for (const height of [Infinity, NaN, -1, 16000001])
    expect(() => previewLocator({ ...locator, viewport: { width: 800, height } })).toThrow(
      "Invalid rendered viewport",
    );
});
test("preview bridge exposes only its artifact's human conversation at the selected version", async () => {
  const context: PreviewPageContext = {
    artifactId: "artifact_fixture",
    versionSeq: 2,
    path: "page.html",
    representation: "rendered",
    resourceRoot: "https://preview.example/files/",
    state: "active",
  };
  const threads = { id: "thread_fixture", comments: [] } as unknown as ArtifactThread;
  const detail = { threads: [threads] } as ArtifactDetail;
  const calls: unknown[] = [];
  const api = {
    addThread: async (...args: unknown[]) => {
      calls.push(args);
      return threads;
    },
    comment: async (...args: unknown[]) => {
      calls.push(args);
      return {} as ArtifactComment;
    },
    submit: async (...args: unknown[]) => {
      calls.push(args);
      return { notification: { state: "sent" as const } };
    },
  };
  const call = (method: string, value?: unknown, activated = false) =>
    previewBridgeCall(method, value, context, detail, api, activated);
  expect(await call("getContext")).toEqual(context);
  expect(await call("getThreads")).toEqual([threads]);
  detail.threads = [
    {
      ...threads,
      comments: [
        {
          ...threads.comments[0]!,
          attachments: [{ id: "private-image" }] as ArtifactComment["attachments"],
        },
        { id: "comment", attachments: [{ id: "private-comment-image" }] } as ArtifactComment,
      ],
    },
  ];
  expect(await call("getThreads")).toEqual([{ id: threads.id, comments: [{}, { id: "comment" }] }]);
  const media = {
    kind: "media",
    versionSeq: 2,
    path: "image.png",
    locator: {
      time: null,
      box: { x: 0, y: 0, width: 1, height: 1 },
      frame: { id: "private-frame" },
    },
  } as unknown as ArtifactThread["target"];
  detail.threads[0]!.target = media;
  detail.threads[0]!.anchor = {
    target: media,
    revision: 1,
    actor: { role: "human", sessionId: null },
    createdAt: "test",
    updatedAt: "test",
  } as NonNullable<ArtifactThread["anchor"]>;
  detail.threads[0]!.comments[1]!.target = media as ArtifactComment["target"];
  expect(JSON.stringify(await call("getThreads"))).not.toContain("private-frame");
  expect(JSON.stringify(detail.threads)).toContain("private-frame");
  await expect(call("createThread", { body: "Spoof", attachments: [] }, true)).rejects.toThrow(
    "scope",
  );
  for (const method of [
    "publish",
    "archive",
    "claim",
    "fetch",
    "exec",
    "createSession",
    "createDiscussion",
    "setTheme",
  ])
    await expect(call(method, {}, true)).rejects.toThrow("Unsupported");
  for (const method of ["createThread", "comment", "submit"])
    await expect(call(method)).rejects.toThrow("user action");
  await expect(
    call("comment", { threadId: "thread_other", body: "Another artifact" }, true),
  ).rejects.toThrow("not part");
  await expect(
    call("createThread", { body: "Spoof", actor: { role: "agent" } }, true),
  ).rejects.toThrow("scope");
  await expect(
    call("comment", { discussionId: threads.id, body: "Former spelling" }, true),
  ).rejects.toThrow("scope");
  await expect(
    call(
      "createThread",
      { body: "Navigate", locator: { selector: "h1", route: "https://outside.example" } },
      true,
    ),
  ).rejects.toThrow("document");
  expect(calls).toHaveLength(0);
  await call(
    "createThread",
    { body: "Revise", locator: { selector: "#heading", quote: "Visible\n text" } },
    true,
  );
  expect(calls[0]).toEqual([
    context.artifactId,
    "Revise",
    {
      kind: "rendered",
      versionSeq: 2,
      path: "page.html",
      locator: { selector: "#heading", quote: "Visible text" },
    },
  ]);
  await call("comment", { threadId: threads.id, body: "About version two" }, true);
  expect(calls[1]).toEqual([threads.id, { body: "About version two" }]);
  await call("submit", undefined, true);
  expect(calls[2]).toEqual([context.artifactId]);
});
test("selection bounds stay finite and within the visible part of a tall frame", () => {
  const frame = { left: 200, right: 1000, top: -5000, bottom: 200000 };
  const visible = { left: 200, right: 1000, top: 80, bottom: 700 };
  expect(
    previewSelectionPosition({ left: 20, right: 100, top: 5200, bottom: 5240 }, frame, visible),
  ).toEqual({ left: 260, top: 200, bottom: 240 });
  expect(
    previewSelectionPosition({ left: -500, right: 100, top: 0, bottom: 200000 }, frame, visible),
  ).toEqual({ left: 200, top: 80, bottom: 700 });
  for (const rect of [
    null,
    {},
    { left: 0, right: NaN, top: 0, bottom: 20 },
    { left: 2, right: 1, top: 0, bottom: 20 },
    { left: 0, right: 20, top: 0, bottom: Infinity },
  ])
    expect(() => previewSelectionPosition(rect, frame, visible)).toThrow("selection bounds");
});
