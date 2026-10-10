import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactApi } from "../server/artifact-api.ts";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import { eventually, openTestBrowser } from "./browser.ts";
import { browserLoweredCssPlugin } from "./spa-css.ts";

// Exercise the real workspace and event stream with controlled POST timing.
const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "preview-workspace-fixture.tsx")],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [await browserLoweredCssPlugin()],
});
if (!build.success) throw new Error("Thread workspace failed to build");
const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
const js = [...assets.keys()].find((name) => name.endsWith(".js"))!;
const css = [...assets.keys()].find((name) => name.endsWith(".css"))!;
const root = await mkdtemp(join(tmpdir(), "r3-threads-creation-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human" as const, sessionId: null };
const artifact = storage.artifacts.create({ kind: "files", actor, title: "Thread creation" });
await storage.artifacts.publish(artifact.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "initial",
  content: {
    kind: "files",
    files: [
      {
        path: "note.txt",
        mediaType: "text/plain",
        base64: Buffer.from("Published content").toString("base64"),
      },
    ],
  },
});
storage.artifacts.registerSession({ id: "threads-test-agent" });
const thread = await storage.conversations.add(artifact.id, {
  actor: { role: "agent", sessionId: "threads-test-agent" },
  body: "Earlier conversation",
  target: { kind: "artifact" },
});
const token = randomBytes(32).toString("base64url");
const api = createArtifactApi(storage, {
  token,
  requireLogin: false,
  version: "acceptance",
  allowedHost: (host) => host === "localhost",
});
let mode: "normal" | "fail" | "early" = "normal";
let releasePost: (() => void) | undefined;
let postedId: string | undefined;
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 30,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === `/api/artifacts/${artifact.id}/threads`) {
      if (mode === "fail")
        return Response.json({ error: "Please retry this save" }, { status: 400 });
      const response = await api.app.fetch(request);
      postedId = (await response.clone().json()).id;
      if (mode === "early")
        await new Promise<void>((resolve) => {
          releasePost = resolve;
        });
      return response;
    }
    if (path.startsWith("/api/")) return api.app.fetch(request);
    const asset = assets.get(path.slice(1));
    if (asset) return new Response(asset);
    return new Response(
      `<!doctype html><html><head><link rel="stylesheet" href="/${css}"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style></head><body><div id="root"></div><script type="module" src="/${js}"></script></body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
let browser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
try {
  browser = await openTestBrowser();
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  await page.command("Page.enable");
  await page.command("Runtime.enable");
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 1400,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.command("Page.navigate", { url: `http://localhost:${app.port}/` });
  await eventually(
    () => page.evaluate("!!document.querySelector('[data-discussion-list] > article')"),
    "initial threads",
  );
  await page.evaluate(`window.threadMotions=[]; window.KeyframeEffect=class extends KeyframeEffect {
    constructor(target,frames,options) {
      super(target,frames,options);
      if(target?.matches('[data-artifact-thread]') && Array.isArray(frames) && frames.some(f=>f.height))
        window.threadMotions.push({id:target.dataset.artifactThread,frames,options});
    }
  }`);
  const input =
    "document.querySelector('[data-artifact-composer]:not([data-comment-to]) textarea')";
  const firstText = "document.querySelector('[data-discussion-list] > article')?.textContent";
  const add = async (body: string) => {
    await page.evaluate("document.querySelector('[aria-label=\"Add comment\"]').click()");
    await eventually(() => page.evaluate(`!!(${input})`), "new-note composer");
    await page.evaluate(`${input}.focus()`);
    await page.command("Input.insertText", { text: body });
    await page.evaluate(`${input}.form.requestSubmit()`);
  };
  const saved = async (body: string, count: number, cardText = firstText) => {
    await eventually(
      () => page.evaluate(`!(${input}) && ${cardText}?.includes(${JSON.stringify(body)})`),
      "saved note occupies its queue position",
    );
    assert.equal(
      await page.evaluate("document.querySelectorAll('[data-discussion-list] > article').length"),
      count,
    );
  };
  await add("First saved note");
  await saved("First saved note", 2);
  await eventually(
    () => page.evaluate("window.threadMotions.length > 0"),
    "composer-to-card height transition",
  );
  const motion = await page.evaluate("window.threadMotions.at(-1)");
  assert.equal(motion.id, postedId);
  assert.equal(motion.options.duration, 280);
  assert.equal(motion.frames[0].transform, "translate(0px, 0px)");

  mode = "early";
  await add("Event stream arrives before POST");
  await eventually(
    () =>
      page.evaluate(`!!(${input}) && ${firstText}?.includes('Event stream arrives before POST')`),
    "early event-stream read",
  );
  const comment = await api.app.request(`http://localhost/api/threads/${postedId}/comments`, {
    method: "POST",
    headers: { host: "localhost", "x-r3-token": token, "content-type": "application/json" },
    body: JSON.stringify({
      actor: { role: "agent", sessionId: "threads-test-agent" },
      body: "Concurrent agent comment",
      context: { versionSeq: null, representation: null },
    }),
  });
  assert.equal(comment.status, 201);
  // An early agent comment moves this note out of the fresh-unsent group. Check
  // the stable card identity while the earlier unsent human note stays ahead.
  const earlyText = `document.querySelector('[data-artifact-thread="${postedId}"]')?.textContent`;
  await eventually(
    () => page.evaluate(`${earlyText}?.includes('Concurrent agent comment')`),
    "concurrent comment arrives",
  );
  releasePost?.();
  await saved("Event stream arrives before POST", 3, earlyText);
  assert(await page.evaluate(`${earlyText}?.includes('Concurrent agent comment')`));
  assert(await page.evaluate(`${firstText}?.includes('First saved note')`));
  await eventually(
    () => page.evaluate(`window.threadMotions.some(m=>m.id===${JSON.stringify(postedId)})`),
    "early card still morphs",
  );

  mode = "fail";
  await add("Retain this failed draft");
  await eventually(
    () =>
      page.evaluate(
        "document.querySelector('[data-artifact-composer] [role=alert]')?.textContent.includes('Please retry')",
      ),
    "failed save",
  );
  assert.equal(await page.evaluate(`${input}.value`), "Retain this failed draft");
  assert.equal(
    await page.evaluate("document.querySelectorAll('[data-discussion-list] > article').length"),
    3,
  );
  mode = "normal";
  await page.command("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await page.evaluate("window.threadMotions=[]");
  await page.evaluate(`${input}.form.requestSubmit()`);
  await saved("Retain this failed draft", 4);
  assert.deepEqual(await page.evaluate("window.threadMotions"), []);
  assert.equal(storage.conversations.list(artifact.id).length, 4);

  const { targetId: otherTarget } = await browser.send("Target.createTarget", {
    url: "about:blank",
  });
  const other = await browser.attach(otherTarget);
  await other.command("Emulation.setDeviceMetricsOverride", {
    width: 1400,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await other.command("Page.navigate", { url: `http://localhost:${app.port}/` });
  await eventually(
    () =>
      other.evaluate("document.querySelectorAll('[data-discussion-list] > article').length === 4"),
    "second tab workspace",
  );
  const edit = async (tab: typeof page, field: string, body: string) => {
    await tab.evaluate(`${field}.focus(); ${field}.select()`);
    await tab.command("Input.insertText", { text: body });
  };
  await page.evaluate("document.querySelector('[aria-label=\"Add comment\"]').click()");
  await eventually(() => page.evaluate(`!!(${input})`), "shared-note composer");
  await edit(page, input, "Shared note from the first tab");
  await eventually(
    () => other.evaluate(`${input}?.value === 'Shared note from the first tab'`),
    "note appears in the second tab",
  );
  await edit(other, input, "Latest shared note");
  await eventually(
    () => page.evaluate(`${input}?.value === 'Latest shared note'`),
    "latest note edit reaches the first tab",
  );

  const commentInput = `document.querySelector('[data-comment-to="${thread.id}"] textarea')`;
  const openComment = async (tab: typeof page) => {
    await tab.evaluate(
      `document.querySelector('[data-artifact-thread="${thread.id}"] [data-thread-action=comment]').click()`,
    );
    await eventually(() => tab.evaluate(`!!(${commentInput})`), "shared-comment composer");
  };
  await openComment(page);
  await openComment(other);
  await edit(page, commentInput, "Independent shared comment");
  await eventually(
    () => other.evaluate(`${commentInput}?.value === 'Independent shared comment'`),
    "comment edit reaches the other tab",
  );
  assert.equal(await other.evaluate(`${input}.value`), "Latest shared note");
  await other.command("Page.reload");
  await eventually(
    () => other.evaluate(`${input}?.value === 'Latest shared note'`),
    "shared note survives reload",
  );
  await openComment(other);
  assert.equal(await other.evaluate(`${commentInput}.value`), "Independent shared comment");
  await other.evaluate(
    `[...${input}.form.querySelectorAll('button')].find(b=>b.textContent==='Discard').click()`,
  );
  // Activate the tab so its exit animation can finish; background tabs pause
  // animation frames even though their storage events have already arrived.
  await page.command("Page.bringToFront");
  await eventually(() => page.evaluate(`!(${input})`), "discard clears the other tab's note");
  assert.equal(await page.evaluate(`${commentInput}.value`), "Independent shared comment");
  await page.evaluate(`${commentInput}.form.requestSubmit()`);
  await other.command("Page.bringToFront");
  await eventually(
    () => other.evaluate(`${commentInput}?.value === ''`),
    "posted comment clears the other tab's draft",
  );
  assert.equal(
    storage.conversations
      .list(artifact.id)
      .find((note) => note.id === thread.id)
      ?.comments.at(-1)?.body,
    "Independent shared comment",
  );
  console.log(
    "Thread creation: save/morph, early SSE and concurrent comment, retry, reduced motion, shared drafts across tabs, last saved edit, reload, discard, and comment cleanup passed.",
  );
} finally {
  releasePost?.();
  await browser?.close();
  api.close();
  await app.stop(true);
  storage.close();
  await rm(root, { recursive: true, force: true });
}
