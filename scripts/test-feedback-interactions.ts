import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactApi } from "../server/artifact-api.ts";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import { eventually, openTestBrowser } from "./browser.ts";
import { browserLoweredCssPlugin } from "./spa-css.ts";

const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "preview-workspace-fixture.tsx")],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [await browserLoweredCssPlugin()],
});
if (!build.success) throw new Error("Feedback acceptance workspace failed to build");
const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
const js = build.outputs
  .find((output) => output.path.endsWith(".js"))!
  .path.split("/")
  .at(-1)!;
const css = build.outputs
  .find((output) => output.path.endsWith(".css"))
  ?.path.split("/")
  .at(-1);
const root = await mkdtemp(join(tmpdir(), "r3-feedback-acceptance-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human" as const, sessionId: null };
const artifact = storage.artifacts.create({ kind: "files", actor, title: "Feedback interactions" });
await storage.artifacts.publish(artifact.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "feedback-interactions",
  content: {
    kind: "files",
    files: [
      {
        path: "index.md",
        mediaType: "text/markdown",
        base64: Buffer.from("# Review this document").toString("base64"),
      },
    ],
  },
});
const notes = await Promise.all(
  ["First decision", "Second decision"].map((body) =>
    storage.conversations.add(artifact.id, { actor, body, target: { kind: "artifact" } }),
  ),
);
const api = createArtifactApi(storage, {
  token: randomBytes(32).toString("base64url"),
  requireLogin: false,
  version: "acceptance",
  allowedHost: (host) => host === "localhost",
});
const pending: { request: Request; respond: (response: Response) => void }[] = [];
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === "PATCH" && /^\/api\/feedback\/[^/]+$/.test(path))
      return new Promise<Response>((respond) => pending.push({ request, respond }));
    if (path.startsWith("/api/")) return api.app.fetch(request);
    const asset = assets.get(path.slice(1));
    if (asset) return new Response(asset);
    return new Response(
      `<!doctype html><html><head>${css ? `<link rel="stylesheet" href="/${css}">` : ""}<style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style></head><body><div id="root"></div><script type="module" src="/${js}"></script></body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
let browser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
try {
  browser = await openTestBrowser();
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 1400,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.command("Page.navigate", { url: `http://localhost:${app.port}/?version=1` });
  const card = (id: string) =>
    `document.querySelector('[data-artifact-feedback="${id}"]:not([inert])')`;
  await eventually(() => page.evaluate(`!!${card(notes[0].id)}`), "feedback cards");
  // Keep the HTTP mutation pending. The user should see resolution immediately,
  // rather than paying for the mutation plus a subsequent artifact refetch.
  await page.evaluate(
    `${card(notes[0].id)}.querySelector('[data-feedback-action="resolve"]').click()`,
  );
  await eventually(async () => pending.length === 1, "held status mutation");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    await page.evaluate("document.querySelector('[data-feedback-tab=active]').textContent"),
    "Active 1",
    "Resolve must update the queue before its HTTP response",
  );
  await storage.conversations.addReply(notes[1].id, {
    actor,
    body: "A reply arrived while saving",
    context: { versionSeq: 1, representation: "source" },
  });
  api.collaboration.broadcast({
    type: "feedback-updated",
    artifactId: artifact.id,
    feedbackId: notes[1].id,
  });
  await eventually(
    () => page.evaluate("document.body.textContent.includes('A reply arrived while saving')"),
    "concurrent reply is refetched",
  );
  assert.equal(
    await page.evaluate("document.querySelector('[data-feedback-tab=active]').textContent"),
    "Active 1",
    "Refetching a reply must preserve the pending resolution",
  );
  await page.evaluate(
    `${card(notes[1].id)}.querySelector('[data-feedback-action="resolve"]').click()`,
  );
  await eventually(async () => pending.length === 2, "two independent status mutations");
  await eventually(
    () =>
      page.evaluate(
        "document.querySelector('[data-feedback-tab=active]').textContent === 'Active 0'",
      ),
    "both decisions are optimistic",
  );
  const first = pending.shift()!;
  first.respond(
    new Response(JSON.stringify({ error: "Simulated save failure" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }),
  );
  await eventually(
    () =>
      page.evaluate(
        "document.querySelector('[data-feedback-tab=active]').textContent === 'Active 1'",
      ),
    "failed resolution restores the thread",
  );
  assert.equal(storage.conversations.list(artifact.id)[0].status, "open");
  await eventually(
    () => page.evaluate(`${card(notes[0].id)}?.textContent.includes('Simulated save failure')`),
    "failed save is explained on the restored card",
  );
  const second = pending.shift()!;
  second.respond(await api.app.fetch(second.request));
  await eventually(
    async () => storage.conversations.list(artifact.id)[1].status === "resolved",
    "other resolution persists independently",
  );
  await page.evaluate("document.querySelector('[data-feedback-tab=resolved]').click()");
  await eventually(
    () =>
      page.evaluate(`${card(notes[1].id)}?.textContent.includes('A reply arrived while saving')`),
    "the concurrent reply survives completion",
  );
  await eventually(
    () =>
      page.evaluate(
        `!${card(notes[1].id)}.querySelector('[data-feedback-action="resolve"]').disabled`,
      ),
    "saved decision can be reopened",
  );
  await page.evaluate(
    `${card(notes[1].id)}.querySelector('[data-feedback-action="resolve"]').click()`,
  );
  await eventually(async () => pending.length === 1, "held reopen mutation");
  await eventually(
    () =>
      page.evaluate(
        "document.querySelector('[data-feedback-tab=resolved]').textContent === 'Resolved 0'",
      ),
    "Reopen also updates immediately",
  );
  const reopen = pending.shift()!;
  reopen.respond(await api.app.fetch(reopen.request));
  await eventually(
    async () => storage.conversations.list(artifact.id)[1].status === "open",
    "reopen persists",
  );
  await page.evaluate("document.querySelector('[data-feedback-tab=active]').click()");
  await page.evaluate(
    "Promise.all(document.getAnimations().map(animation=>animation.finished.catch(()=>{})))",
  );
  await page.evaluate("document.querySelector('[aria-label=\"Add general feedback\"]').click()");
  await eventually(
    () => page.evaluate("!!document.querySelector('[aria-label=\"Feedback\"]')"),
    "pending feedback composer",
  );
  assert.equal(
    await page.evaluate(
      "!!document.querySelector('[data-artifact-composer]').closest('[data-feedback-list]')",
    ),
    true,
    "The composer belongs to the feedback list like a pending card",
  );
  await page.evaluate(
    "Promise.all(document.getAnimations().map(animation=>animation.finished.catch(()=>{})))",
  );
  const composerTop = await page.evaluate<number>(
    "document.querySelector('[aria-label=\"Feedback\"]').getBoundingClientRect().top",
  );
  await page.evaluate("document.querySelector('[aria-label=\"Feedback\"]').focus()");
  await page.command("Input.insertText", { text: "A pending card" });
  await page.evaluate("new Promise(requestAnimationFrame)");
  assert.equal(
    await page.evaluate(
      "document.querySelector('[aria-label=\"Feedback\"]').getBoundingClientRect().top",
    ),
    composerTop,
    "Typing must not add a header row above the composer",
  );
  await page.evaluate(
    "[...document.querySelectorAll('[data-artifact-composer] button')].find(b=>b.textContent==='Discard').click()",
  );
  await eventually(
    () =>
      page.evaluate(
        `${card(notes[0].id)}?.getAnimations().some(animation=>animation.effect.getKeyframes().some(frame=>frame.transform?.includes('translate')))`,
      ),
    "discard animates the remaining feedback cards",
  );
  await eventually(
    () => page.evaluate("!document.querySelector('[data-artifact-composer]')"),
    "discarded composer leaves the list",
  );
  await page.evaluate(
    "Promise.all(document.getAnimations().map(animation=>animation.finished.catch(()=>{})))",
  );
  await page.evaluate("document.querySelector('[aria-label=\"Add general feedback\"]').click()");
  await eventually(
    () => page.evaluate("!!document.querySelector('[data-artifact-composer]')"),
    "empty pending card",
  );
  await page.evaluate(
    "Promise.all(document.getAnimations().map(animation=>animation.finished.catch(()=>{})))",
  );
  await page.evaluate(
    "[...document.querySelectorAll('[data-artifact-composer] button')].find(b=>b.textContent==='Cancel').click()",
  );
  await eventually(
    () =>
      page.evaluate(
        `${card(notes[0].id)}?.getAnimations().some(animation=>animation.effect.getKeyframes().some(frame=>frame.transform?.includes('translate')))`,
      ),
    "cancel animates the remaining feedback cards",
  );
  const panel = "document.querySelector('[data-feedback-mode]')";
  const geometry = () =>
    page.evaluate<{ x: number; y: number; width: number; height: number }>(
      `${panel}.getBoundingClientRect().toJSON()`,
    );
  const docked = await geometry();
  await page.evaluate("document.querySelector('[aria-label=\"Float feedback\"]').click()");
  await eventually(
    () => page.evaluate(`${panel}.dataset.feedbackMode === 'floating'`),
    "floating panel",
  );
  const initial = await geometry();
  const contentWidth = await page.evaluate<number>(
    `${panel}.previousElementSibling.getBoundingClientRect().width`,
  );
  // Exercise capture across an opaque document, as in an HTML preview. Release
  // over the frame must still finish the drag and persist the final geometry.
  await page.evaluate(
    `${panel}.previousElementSibling.insertAdjacentHTML('beforeend', '<iframe sandbox="allow-scripts" srcdoc="<p>Preview</p>" style="position:absolute;inset:0;width:45%;height:100%;border:0"></iframe>')`,
  );
  const drag = async (selector: string, dx: number, dy: number) => {
    const point = await page.evaluate<{ x: number; y: number }>(
      `(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    );
    await page.command("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...point,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await page.command("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x + dx,
      y: point.y + dy,
      button: "left",
      buttons: 1,
    });
    await page.command("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: point.x + dx,
      y: point.y + dy,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    await page.evaluate("new Promise(requestAnimationFrame)");
  };
  await drag("[data-feedback-drag]", -600, 0);
  const moved = await geometry();
  assert.ok(
    Math.abs(moved.x - initial.x + 600) < 2,
    "Floating header moves the panel across a preview iframe",
  );
  assert.equal(
    await page.evaluate("document.body.style.cursor"),
    "",
    "Drag release clears body styling",
  );
  await drag("[data-feedback-resize=se]", 60, -180);
  const resized = await geometry();
  assert.ok(Math.abs(resized.width - moved.width - 60) < 2, "Corner resizing changes width");
  assert.ok(Math.abs(resized.height - moved.height + 180) < 2, "Corner resizing changes height");
  await drag("[data-feedback-drag]", 70, 70);
  const placed = await geometry();
  assert.ok(Math.abs(placed.y - resized.y - 70) < 2, "A smaller floating panel moves vertically");
  assert.equal(
    await page.evaluate(`${panel}.previousElementSibling.getBoundingClientRect().width`),
    contentWidth,
    "Floating interactions do not shift content",
  );
  await page.evaluate("document.querySelector('[aria-label=\"Hide feedback\"]').click()");
  await eventually(
    () => page.evaluate(`${panel}.dataset.feedbackMode === 'hidden'`),
    "hidden floating panel",
  );
  await page.evaluate("document.querySelector('[aria-label=\"Show feedback\"]').click()");
  await eventually(
    () => page.evaluate(`${panel}.dataset.feedbackMode === 'floating'`),
    "restore floating mode",
  );
  assert.deepEqual(await geometry(), placed, "Hide/show restores floating geometry");
  await page.evaluate("document.querySelector('[aria-label=\"Dock feedback\"]').click()");
  await page.evaluate(
    "Promise.all(document.getAnimations().map(animation=>animation.finished.catch(()=>{})))",
  );
  assert.equal(
    (await geometry()).width,
    docked.width,
    "Docking restores the independent dock width",
  );
  await page.evaluate("document.querySelector('[aria-label=\"Float feedback\"]').click()");
  await page.command("Page.reload");
  await eventually(
    () => page.evaluate(`!!${panel} && ${panel}.dataset.feedbackMode === 'floating'`),
    "floating panel after reload",
  );
  assert.deepEqual(await geometry(), placed, "Reload restores the saved position and size");
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 900,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await eventually(
    () =>
      page.evaluate(
        `(()=>{const p=${panel}.getBoundingClientRect();const w=${panel}.parentElement.getBoundingClientRect();return p.x>=w.x && p.y>=w.y && p.right<=w.right && p.bottom<=w.bottom})()`,
      ),
    "floating controls stay within a smaller workspace",
  );
  const beforeKey = await geometry();
  await page.evaluate("document.querySelector('[data-feedback-resize=se]').focus()");
  await page.command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "ArrowLeft",
    code: "ArrowLeft",
    windowsVirtualKeyCode: 37,
  });
  assert.equal(
    (await geometry()).width,
    beforeKey.width - 10,
    "Resize handle supports keyboard input",
  );
  console.log(
    "Floating feedback: drag across an opaque frame, resize, independent docking, hide/show, reload, viewport clamping and keyboard resizing passed.",
  );
  console.log(
    "Feedback decisions update immediately with safe rollback; the composer shares the list, typing stays stable, and Cancel/Discard animate surrounding cards.",
  );
} finally {
  for (const request of pending) request.respond(new Response(null, { status: 503 }));
  await browser?.close();
  app.stop(true);
  storage.close();
  await rm(root, { recursive: true, force: true });
}
