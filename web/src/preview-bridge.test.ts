import { expect, test } from "bun:test";
import type { ArtifactDetail, ArtifactFeedback, ArtifactReply } from "../../shared/artifacts.ts";
import type { PreviewPageContext } from "../../shared/preview-protocol.ts";
import { previewBridgeCall } from "./preview-bridge.ts";
import { previewThemePreference } from "./preview-theme.ts";

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
    previewBridgeCall(method, value, context, detail, api, activated, {
      get: () => null,
      set: () => {},
    });
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

test("preview themes persist only a user-selected light/dark preference for their artifact", async () => {
  const values = new Map([["r3-theme", "light"]]);
  const storage = () => ({
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  });
  const context: PreviewPageContext = {
    artifactId: "artifact_theme",
    versionSeq: 1,
    path: "index.html",
    resourceRoot: "https://preview.example/files/",
    representation: "rendered",
    state: "active",
  };
  const unavailable = async (): Promise<never> => {
    throw new Error("Unexpected conversation mutation");
  };
  const call = (method: string, value?: unknown, activated = false, scope = context) =>
    previewBridgeCall(
      method,
      value,
      scope,
      { feedback: [] } as unknown as ArtifactDetail,
      { addFeedback: unavailable, reply: unavailable, submit: unavailable },
      activated,
      previewThemePreference(storage, scope.artifactId),
    );
  expect(await call("getTheme")).toBeNull();
  await expect(call("setTheme", "dark")).rejects.toThrow("user action");
  for (const value of [
    "system",
    null,
    { theme: "dark", artifactId: "artifact_other" },
    { key: "r3-theme", value: "dark" },
  ])
    await expect(call("setTheme", value, true)).rejects.toThrow("light or dark");
  expect(values.size).toBe(1);
  await call("setTheme", "dark", true);
  expect(await call("getTheme")).toBe("dark");
  expect(await call("getTheme", undefined, false, { ...context, versionSeq: 2 })).toBe("dark");
  expect(
    await call("getTheme", undefined, false, { ...context, artifactId: "artifact_other" }),
  ).toBeNull();
  await call("setTheme", "light", true);
  expect(await call("getTheme")).toBe("light");
  expect(values.get("r3-theme")).toBe("light");
  expect(values.size).toBe(2);
  const blocked = previewThemePreference(() => {
    throw new Error("Storage unavailable");
  }, context.artifactId);
  // Unavailable browser storage cannot disable unrelated conversation reads.
  expect(
    await previewBridgeCall(
      "getContext",
      undefined,
      context,
      {} as ArtifactDetail,
      { addFeedback: unavailable, reply: unavailable, submit: unavailable },
      false,
      blocked,
    ),
  ).toEqual(context);
});
