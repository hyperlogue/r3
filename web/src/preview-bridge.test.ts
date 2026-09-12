import { expect, test } from "bun:test";
import type { ArtifactDetail, ArtifactFeedback, ArtifactReply } from "../../shared/artifacts.ts";
import type { PreviewPageContext } from "../../shared/preview-protocol.ts";
import { previewBridgeCall } from "./preview-bridge.ts";

test("preview bridge exposes only its artifact's human conversation at the selected version", async () => {
  const context: PreviewPageContext = {
    artifactId: "artifact_fixture",
    versionSeq: 2,
    path: "page.html",
    representation: "rendered",
    resourceRoot: "https://preview.example/files/",
    state: "active",
  };
  const feedback = { id: "feedback_fixture" } as ArtifactFeedback;
  const detail = { feedback: [feedback] } as ArtifactDetail;
  const calls: unknown[] = [];
  const api = {
    addFeedback: async (...args: unknown[]) => {
      calls.push(args);
      return feedback;
    },
    reply: async (...args: unknown[]) => {
      calls.push(args);
      return {} as ArtifactReply;
    },
    submit: async (...args: unknown[]) => {
      calls.push(args);
      return { notification: { state: "sent" as const } };
    },
  };
  const call = (method: string, value?: unknown, activated = false) =>
    previewBridgeCall(method, value, context, detail, api, activated);
  expect(await call("getContext")).toEqual(context);
  expect(await call("getThreads")).toEqual([feedback]);
  for (const method of ["publish", "archive", "claim", "fetch", "exec", "createSession"])
    await expect(call(method, {}, true)).rejects.toThrow("Unsupported");
  for (const method of ["createFeedback", "reply", "submit"])
    await expect(call(method)).rejects.toThrow("user action");
  await expect(
    call("reply", { feedbackId: "feedback_other", body: "Another artifact" }, true),
  ).rejects.toThrow("not part");
  await expect(
    call("createFeedback", { body: "Spoof", actor: { role: "agent" } }, true),
  ).rejects.toThrow("scope");
  await expect(
    call(
      "createFeedback",
      { body: "Navigate", locator: { selector: "h1", route: "https://outside.example" } },
      true,
    ),
  ).rejects.toThrow("document");
  expect(calls).toHaveLength(0);
  await call(
    "createFeedback",
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
  await call("reply", { feedbackId: feedback.id, body: "About version two" }, true);
  expect(calls[1]).toEqual([
    feedback.id,
    { body: "About version two", context: { versionSeq: 2, representation: "rendered" } },
  ]);
  await call("submit", undefined, true);
  expect(calls[2]).toEqual([context.artifactId]);
});
