import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifactSearchParams } from "../shared/artifact-search.ts";
import { parseArtifactSearch } from "./artifact-search.ts";
import { type ArtifactStorage, openArtifactStorage } from "./artifact-storage.ts";

let root: string;
let storage: ArtifactStorage;
const human = { role: "human", sessionId: null } as const;
const agent = { role: "agent", sessionId: "search-agent" } as const;
const settings = () => ({
  databasePath: join(root, "store.sqlite"),
  render: async (text: string) => ({ html: `<main>${text}</main>`, revision: "search-test" }),
});
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-search-"));
  storage = await openArtifactStorage(settings());
  storage.artifacts.registerSession({ id: agent.sessionId });
});
afterEach(async () => {
  storage.close();
  await rm(root, { recursive: true, force: true });
});
const search = (q: string, extra = {}) =>
  storage.search.search(parseArtifactSearch(artifactSearchParams({ q, ...extra })));
const create = (kind = "files", extra = {}) =>
  storage.artifacts.create({ kind, actor: human, title: "Design notes", ...extra });
const publish = (id: string, text: string, expectedSeq = 0, extra = {}) =>
  storage.artifacts.publish(id, {
    actor: agent,
    expectedSeq,
    publicationKey: `version-${expectedSeq}`,
    content: {
      kind: "files",
      files: [
        {
          path: "notes.md",
          mediaType: "text/markdown",
          base64: Buffer.from(text).toString("base64"),
        },
      ],
    },
    ...extra,
  });

test("latest search, history, summaries and source locations use actual published membership", async () => {
  const artifact = create();
  await publish(artifact.id, "# Notes\nKeyboard focus used to disappear\n", 0, {
    summary: "Initial keyboard exploration",
  });
  await publish(artifact.id, "# Notes\nThe toolbar now shows focus\n", 1, {
    summary: "New toolbar",
  });
  expect((await search("keyboard")).total).toBe(0);
  const history = await search("keyb", { history: "all" });
  expect(history.total).toBe(2);
  expect(history.matches.find((m) => m.category === "content")?.target).toEqual({
    kind: "source",
    versionSeq: 1,
    path: "notes.md",
    locator: { start: 2, end: 2, quote: "Keyboard focus used to disappear" },
  });
  expect((await search("toolbar")).matches.every((m) => m.versionSeq === 2)).toBe(true);
  expect(history.artifacts[0].latestVersion?.seq).toBe(2);
  storage.close();
  storage = await openArtifactStorage(settings());
  expect((await search("keyboard", { history: "all" })).total).toBe(2);
});

test("conversation edits, replies, resolution, archive and deletion reconcile without delivery changes", async () => {
  const artifact = create();
  await publish(artifact.id, "Original document");
  const feedback = await storage.conversations.add(artifact.id, {
    actor: human,
    body: "Keyboard feedback",
    target: { kind: "source", versionSeq: 1, path: "notes.md", locator: null },
  });
  await publish(artifact.id, "Replacement document", 1);
  const reply = await storage.conversations.addReply(feedback.id, {
    actor: agent,
    body: "Keyboard fix ready",
    target: { kind: "source", versionSeq: 2, path: "notes.md", locator: null },
  });
  const found = await search("keyboard", { type: "conversation", attention: true });
  expect(found.total).toBe(2);
  expect(found.matches.find((m) => m.category === "feedback")?.versionSeq).toBe(1);
  expect(found.matches.find((m) => m.category === "reply")).toMatchObject({
    versionSeq: 2,
    replyId: reply.id,
    feedbackId: feedback.id,
  });
  expect(storage.conversations.get(feedback.id).sentAt).toBeNull();
  await storage.conversations.editReply(reply.id, { actor: agent, body: "Pointer fix ready" });
  await storage.conversations.edit(feedback.id, {
    actor: human,
    body: "Pointer feedback",
    status: "resolved",
  });
  expect((await search("keyboard")).total).toBe(0);
  expect((await search("pointer", { type: "conversation" })).total).toBe(2);
  expect((await search("pointer", { attention: true })).total).toBe(0);
  storage.lifecycle.transition(artifact.id, {
    actor: human,
    event: "archived",
    operationKey: "archive",
  });
  expect((await search("pointer", { state: "active" })).total).toBe(0);
  expect((await search("pointer", { state: "archived" })).total).toBe(2);
  expect(() => storage.conversations.delete(feedback.id, human)).toThrow("archived");
  storage.lifecycle.transition(artifact.id, {
    actor: human,
    event: "restored",
    operationKey: "restore",
  });
  storage.conversations.delete(feedback.id, human);
  expect((await search("pointer")).total).toBe(0);
  storage.artifacts.delete(artifact.id);
  expect((await search("document", { history: "all" })).total).toBe(0);
});

test("HTML indexes passive text with entities, excludes scripts and companions, and returns rendered evidence", async () => {
  const artifact = create("html");
  const files = [
    {
      path: "index.html",
      mediaType: "text/html",
      base64: Buffer.from(
        "<!doctype html><html><head><title>HeadOnly</title><style>.styleonly{}</style></head><body><h1>Keyboard &amp; focus</h1><script>ScriptOnly()</script><template>TemplateOnly</template><div hidden>HiddenOnly</div></body></html>",
      ).toString("base64"),
    },
    {
      path: "companion.js",
      mediaType: "text/javascript",
      base64: Buffer.from("CompanionOnly").toString("base64"),
    },
  ];
  await publish(artifact.id, "", 0, { content: { kind: "html", files } });
  const result = await search("keyboard focus");
  expect(result.matches[0].snippet).toBe("Keyboard & focus");
  expect(result.matches[0].target).toEqual({
    kind: "rendered",
    versionSeq: 1,
    path: "index.html",
    locator: { selector: "body", quote: "Keyboard & focus" },
  });
  for (const q of [
    "HeadOnly",
    "StyleOnly",
    "ScriptOnly",
    "TemplateOnly",
    "HiddenOnly",
    "CompanionOnly",
  ])
    expect((await search(q)).total).toBe(0);
});

test("sparse diff search retains old/new coordinates and never joins missing context", async () => {
  const artifact = create("diff");
  const patch =
    "diff --git a/control.ts b/control.ts\n--- a/control.ts\n+++ b/control.ts\n@@ -10,2 +10,2 @@\n-old keyboard\n+new keyboard\n context\n@@ -80 +80 @@\n-removed marker\n+added marker\n";
  await publish(artifact.id, "", 0, { content: { kind: "diff", patch } });
  const found = await search("keyboard");
  expect(found.total).toBe(2);
  expect(found.matches.map((m) => m.target)).toContainEqual({
    kind: "diff",
    versionSeq: 1,
    path: "control.ts",
    locator: { side: "old", start: 10, end: 10, quote: "old keyboard" },
  });
  expect(found.matches.map((m) => m.target)).toContainEqual({
    kind: "diff",
    versionSeq: 1,
    path: "control.ts",
    locator: { side: "new", start: 10, end: 10, quote: "new keyboard" },
  });
  expect((await search("keyboard marker")).total).toBe(0);
});

test("project/kind filters, pagination, literal FTS operators and stale metadata", async () => {
  const project = storage.artifacts.createProject({ name: "Keyboard project" });
  for (let i = 0; i < 3; i++) {
    const a = create("files", { title: `Keyboard ${i}`, projectId: project.id });
    await publish(a.id, "Focused controls");
  }
  const result = await search("keyb", { project: project.id, limit: 2 });
  expect(result.total).toBe(3);
  expect(result.nextOffset).toBe(2);
  const next = await search("keyb", { project: project.id, limit: 2, offset: 2 });
  expect(next.matches).toHaveLength(1);
  expect(next.nextOffset).toBeNull();
  expect(result.matches.some((m) => m.id === next.matches[0].id)).toBe(false);
  expect((await search('" OR keyboard')).total).toBe(0);
  expect((await search("keyboard", { kind: "diff" })).total).toBe(0);
  expect((await search("keyboard", { project: "nonexistent" })).total).toBe(0);
  storage.artifacts.editProject(project.id, { name: "Pointer project" });
  expect((await search("pointer")).total).toBe(3);
  expect(() => parseArtifactSearch(new URLSearchParams({ q: "*" }))).toThrow();
  expect(() => parseArtifactSearch(new URLSearchParams({ q: "x", limit: "5000" }))).toThrow();
  expect(() => parseArtifactSearch(new URLSearchParams({ q: "x", history: "invalid" }))).toThrow();
});

test("publication and deletion during indexing cannot leave a stale latest search snapshot", async () => {
  const artifact = create();
  await publish(artifact.id, "Previous publication");
  const read = storage.artifacts.readFile.bind(storage.artifacts);
  let changed = false;
  storage.artifacts.readFile = async (...args) => {
    const bytes = await read(...args);
    if (!changed) {
      changed = true;
      await publish(artifact.id, "Concurrent publication", 1);
    }
    return bytes;
  };
  const result = await search("concurrent");
  expect(result.matches).toHaveLength(1);
  expect(result.matches[0].versionSeq).toBe(2);
  const removed = create();
  await publish(removed.id, "Deleted publication");
  storage.artifacts.readFile = async (...args) => {
    const bytes = await read(...args);
    storage.artifacts.delete(removed.id);
    return bytes;
  };
  expect((await search("deleted")).total).toBe(0);
});

test("binary, oversized and invalid UTF-8 bytes are excluded explicitly", async () => {
  const artifact = create();
  await publish(artifact.id, "", 0, {
    content: {
      kind: "files",
      files: [
        {
          path: "binary.dat",
          mediaType: "application/octet-stream",
          base64: Buffer.from([0, 255]).toString("base64"),
        },
        {
          path: "invalid.txt",
          mediaType: "text/plain",
          base64: Buffer.from([255]).toString("base64"),
        },
        {
          path: "large.txt",
          mediaType: "text/plain",
          base64: Buffer.alloc(4 * 1024 * 1024 + 1, "x").toString("base64"),
        },
      ],
    },
  });
  const result = await search("missing");
  expect(result.matches).toEqual([]);
  expect(result.skippedFiles).toBe(3);
});
