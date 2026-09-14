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
if (!build.success) throw new Error("Feedback workspace failed to build");
const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
const js = [...assets.keys()].find((name) => name.endsWith(".js"))!;
const css = [...assets.keys()].find((name) => name.endsWith(".css"))!;
const root = await mkdtemp(join(tmpdir(), "r3-feedback-creation-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human" as const, sessionId: null };
const artifact = storage.artifacts.create({ kind: "files", actor, title: "Feedback creation" });
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
await storage.conversations.add(artifact.id, {
  actor,
  body: "Earlier conversation",
  target: { kind: "artifact" },
});
storage.artifacts.registerSession({ id: "feedback-test-agent" });
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
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && path === `/api/artifacts/${artifact.id}/feedback`) {
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
    () => page.evaluate("!!document.querySelector('[data-feedback-list] > article')"),
    "initial feedback",
  );
  await page.evaluate(`window.feedbackMotions=[]; window.KeyframeEffect=class extends KeyframeEffect {
    constructor(target,frames,options) {
      super(target,frames,options);
      if(target?.matches('[data-artifact-feedback]') && Array.isArray(frames) && frames.some(f=>f.height))
        window.feedbackMotions.push({id:target.dataset.artifactFeedback,frames,options});
    }
  }`);
  const input = "document.querySelector('[data-artifact-composer]:not([data-reply-to]) textarea')";
  const firstText = "document.querySelector('[data-feedback-list] > article')?.textContent";
  const add = async (body: string) => {
    await page.evaluate("document.querySelector('[aria-label=\"Add general feedback\"]').click()");
    await eventually(() => page.evaluate(`!!(${input})`), "new-note composer");
    await page.evaluate(`${input}.focus()`);
    await page.command("Input.insertText", { text: body });
    await page.evaluate(`${input}.form.requestSubmit()`);
  };
  const saved = async (body: string, count: number) => {
    await eventually(
      () => page.evaluate(`!(${input}) && ${firstText}?.includes(${JSON.stringify(body)})`),
      "saved note stays at top",
    );
    assert.equal(
      await page.evaluate("document.querySelectorAll('[data-feedback-list] > article').length"),
      count,
    );
  };
  await add("First saved note");
  await saved("First saved note", 2);
  await eventually(
    () => page.evaluate("window.feedbackMotions.length > 0"),
    "composer-to-card height transition",
  );
  const motion = await page.evaluate("window.feedbackMotions.at(-1)");
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
  const reply = await api.app.request(`http://localhost/api/feedback/${postedId}/replies`, {
    method: "POST",
    headers: { host: "localhost", "x-r3-token": token, "content-type": "application/json" },
    body: JSON.stringify({
      actor: { role: "agent", sessionId: "feedback-test-agent" },
      body: "Concurrent agent reply",
      context: { versionSeq: null, representation: null },
    }),
  });
  assert.equal(reply.status, 201);
  await eventually(
    () => page.evaluate(`${firstText}?.includes('Concurrent agent reply')`),
    "concurrent reply arrives",
  );
  releasePost?.();
  await saved("Event stream arrives before POST", 3);
  assert(await page.evaluate(`${firstText}?.includes('Concurrent agent reply')`));
  await eventually(
    () => page.evaluate(`window.feedbackMotions.some(m=>m.id===${JSON.stringify(postedId)})`),
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
    await page.evaluate("document.querySelectorAll('[data-feedback-list] > article').length"),
    3,
  );
  mode = "normal";
  await page.command("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await page.evaluate("window.feedbackMotions=[]");
  await page.evaluate(`${input}.form.requestSubmit()`);
  await saved("Retain this failed draft", 4);
  assert.deepEqual(await page.evaluate("window.feedbackMotions"), []);
  assert.equal(storage.conversations.list(artifact.id).length, 4);
  console.log(
    "Feedback creation: newest-first save, composer morph, early SSE and concurrent reply, duplicate avoidance, failed draft, retry, and reduced motion passed.",
  );
} finally {
  releasePost?.();
  await browser?.close();
  api.close();
  await app.stop(true);
  storage.close();
  await rm(root, { recursive: true, force: true });
}
