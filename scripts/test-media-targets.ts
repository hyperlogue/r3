import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactApi } from "../server/artifact-api.ts";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import type { ArtifactMediaTarget } from "../shared/artifacts.ts";
import { eventually, openTestBrowser } from "./browser.ts";
import { browserLoweredCssPlugin } from "./spa-css.ts";

// Real capture, drafts and comparison against an isolated daemon and browser.
// Supply installed Chromium and ffmpeg; no downloads or normal workspace state.
const root = await mkdtemp(join(tmpdir(), "r3-media-targets-"));
const out = "workspace/media-target-acceptance";
await mkdir(out, { recursive: true });
const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "preview-workspace-fixture.tsx")],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [await browserLoweredCssPlugin()],
});
if (!build.success) throw new Error("Media workspace fixture failed to build");
const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
const js = [...assets.keys()].find((path) => path.endsWith(".js"))!;
const css = [...assets.keys()].find((path) => path.endsWith(".css"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const human = { role: "human", sessionId: null } as const;
const agent = { role: "agent", sessionId: "media-acceptance-agent" } as const;
storage.artifacts.registerSession({ id: agent.sessionId, label: "Design agent" });
const artifact = storage.artifacts.create({ kind: "files", actor: human, title: "Media targets" });
for (const seq of [1, 2]) {
  const generated = Bun.spawn(
    [
      process.env.R3_TEST_FFMPEG ?? "ffmpeg",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc2=size=640x360:rate=12:duration=8`,
      "-c:v",
      "libvpx",
      "-b:v",
      "200k",
      join(root, `clip-${seq}.webm`),
    ],
    { stdout: "ignore", stderr: "inherit" },
  );
  assert.equal(await generated.exited, 0);
  const image = Bun.spawn(
    [
      process.env.R3_TEST_FFMPEG ?? "ffmpeg",
      "-v",
      "error",
      "-i",
      join(root, `clip-${seq}.webm`),
      "-frames:v",
      "1",
      join(root, `image-${seq}.png`),
    ],
    { stdout: "ignore", stderr: "inherit" },
  );
  assert.equal(await image.exited, 0);
  await storage.artifacts.publish(artifact.id, {
    actor: human,
    expectedSeq: seq - 1,
    publicationKey: `v${seq}`,
    content: {
      kind: "files",
      files: [
        {
          path: "clip.webm",
          mediaType: "video/webm",
          base64: Buffer.from(
            await Bun.file(join(root, `clip-${seq}.webm`)).arrayBuffer(),
          ).toString("base64"),
        },
        {
          path: "image.png",
          mediaType: "image/png",
          base64: Buffer.from(
            await Bun.file(join(root, `image-${seq}.png`)).arrayBuffer(),
          ).toString("base64"),
        },
      ],
    },
  });
}
const token = randomBytes(32).toString("base64url");
const api = createArtifactApi(storage, {
  token,
  requireLogin: false,
  version: "media-acceptance",
  allowedHost: (host) => host === "localhost",
});
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) return api.app.fetch(request);
    const asset = assets.get(path.slice(1));
    if (asset) return new Response(asset);
    return new Response(
      `<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1">${css ? `<link rel="stylesheet" href="/${css}">` : ""}<style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style></head><body><div id="root"></div><script type="module" src="/${js}"></script></body></html>`,
      { headers: { "Content-Type": "text/html" } },
    );
  },
});
let browser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
try {
  browser = await openTestBrowser();
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 1536,
    height: 1024,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const click = async (selector: string) => {
    await page.evaluate(
      `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'nearest'})`,
    );
    let previous = "";
    let stable = 0;
    const p = await eventually(async () => {
      const point = await page.evaluate(
        `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e || e.disabled)return null;const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;return e.contains(document.elementFromPoint(x,y)) ? {x,y} : null})()`,
      );
      const key = JSON.stringify(point);
      stable = point && key === previous ? stable + 1 : 0;
      previous = key;
      return stable >= 3 && point;
    }, "stable, visible control");
    for (const type of ["mousePressed", "mouseReleased"])
      await page.command("Input.dispatchMouseEvent", { type, button: "left", clickCount: 1, ...p });
  };
  const shot = async (name: string) => {
    await Bun.sleep(400);
    const result = await page.command("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(out, name), Buffer.from(result.data, "base64"));
  };
  const dragPointer = async (from: { x: number; y: number }, to: { x: number; y: number }) => {
    await page.command("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...from,
    });
    await page.command("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      button: "left",
      buttons: 1,
      ...to,
    });
    await page.command("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...to,
    });
  };
  const url = `http://localhost:${app.port}/${artifact.id}?version=1&file=clip.webm`;
  await page.command("Page.navigate", { url });
  await eventually(
    () => page.evaluate("document.querySelector('video')?.readyState >= 2"),
    "native video loaded",
  );
  await page.evaluate("document.querySelector('video').currentTime = 2.345678");
  await eventually(
    () => page.evaluate("!document.querySelector('video').seeking"),
    "seek completed",
  );
  const time = await page.evaluate("document.querySelector('video').currentTime");
  assert.equal(
    await page.evaluate(
      'document.querySelector(\'[data-file="clip.webm"] [aria-label="Pan mode"]\').disabled',
    ),
    true,
  );
  await click('[data-file="clip.webm"] [aria-label="Zoom out"]');
  assert.equal(
    await page.evaluate(
      "document.querySelector('[data-file=\"clip.webm\"] [data-media-viewport]').dataset.zoom",
    ),
    "0.75",
  );
  await click('[data-file="clip.webm"] [aria-label="Reset zoom"]');
  await click('[data-file="clip.webm"] [aria-label="Zoom in"]');
  const videoPanMode = () =>
    page.evaluate(
      'document.querySelector(\'[data-file="clip.webm"] [aria-label="Pan mode"]\').getAttribute("aria-pressed")',
    );
  assert.equal(await videoPanMode(), "true", "zooming in enables pan by default");
  await click('[data-file="clip.webm"] [aria-label="Pan mode"]');
  await click('[data-file="clip.webm"] [aria-label="Zoom in"]');
  assert.equal(await videoPanMode(), "false", "further zoom keeps pan explicitly disabled");
  await click('[data-file="clip.webm"] [aria-label="Pan mode"]');
  await click('[data-file="clip.webm"] [aria-label="Zoom in"]');
  const viewport = await page.evaluate(
    "(()=>{const r=document.querySelector('[data-file=\"clip.webm\"] [data-media-viewport]').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()",
  );
  await dragPointer(
    { x: viewport.x + viewport.w * 0.5, y: viewport.y + viewport.h * 0.5 },
    { x: viewport.x + viewport.w * 0.6, y: viewport.y + viewport.h * 0.55 },
  );
  const panned = await page.evaluate(
    "document.querySelector('[data-file=\"clip.webm\"] [data-media-transform]').style.transform",
  );
  await page.command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "ArrowRight",
    code: "ArrowRight",
  });
  assert.notEqual(
    await page.evaluate(
      "document.querySelector('[data-file=\"clip.webm\"] [data-media-transform]').style.transform",
    ),
    panned,
  );
  await page.command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "ArrowLeft",
    code: "ArrowLeft",
  });
  assert.equal(
    await page.evaluate(
      "document.querySelector('[data-file=\"clip.webm\"] [data-media-viewport]').dataset.zoom",
    ),
    "2",
  );
  await click('[data-file="clip.webm"] [aria-label="Add video feedback"]');
  assert.equal(
    await page.evaluate(
      'document.querySelector(\'[data-file="clip.webm"] [aria-label="Pan mode"]\').getAttribute("aria-pressed")',
    ),
    "false",
  );
  const rect = await page.evaluate(
    "(()=>{const r=document.querySelector('[data-file=\"clip.webm\"] [data-media-frame]').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()",
  );
  const from = { x: rect.x + rect.w * 0.4, y: rect.y + rect.h * 0.45 };
  const to = { x: rect.x + rect.w * 0.65, y: rect.y + rect.h * 0.65 };
  await page.command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    ...from,
  });
  await page.command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    button: "left",
    buttons: 1,
    ...to,
  });
  await page.command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    ...to,
  });
  await eventually(
    () => page.evaluate("!!document.querySelector('[data-artifact-composer] img')"),
    "captured frame in composer",
  );
  assert.equal(await videoPanMode(), "true", "pan resumes after accepting a region");
  const acceptedHash = await page.evaluate(`(async () => {
    const bytes = await fetch(document.querySelector('[data-artifact-composer] img').src).then(r => r.arrayBuffer());
    return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).map(b => b.toString(16).padStart(2, '0')).join('');
  })()`);
  await click("[data-artifact-composer] textarea");
  await page.command("Input.insertText", { text: "Make this region easier to read." });
  await Bun.sleep(550);
  // Scrubbing and reload must preserve the accepted frame, instant and box.
  await page.evaluate("document.querySelector('video').currentTime = 5.5");
  await page.command("Page.reload");
  await eventually(
    () => page.evaluate("!!document.querySelector('[data-artifact-composer] img')"),
    "draft frame restored",
  );
  await shot("01-video-feedback.png");
  await click('[data-artifact-composer] button[type="submit"]');
  await eventually(
    async () => storage.conversations.list(artifact.id).length === 1,
    "media feedback saved",
  );
  const note = storage.conversations.list(artifact.id)[0]!;
  const original = note.target as ArtifactMediaTarget;
  assert.equal(original.locator.time, time);
  assert.ok(Math.abs(original.locator.box.x - 0.4) < 0.01);
  assert.ok(Math.abs(original.locator.box.y - 0.45) < 0.01);
  assert.ok(Math.abs(original.locator.box.width - 0.25) < 0.01);
  assert.ok(Math.abs(original.locator.box.height - 0.2) < 0.01);
  assert.equal(original.locator.frame?.width, 640);
  assert.equal(original.locator.frame?.hash, acceptedHash);
  // Publish a native fix at another instant and retained version.
  const fix = await storage.conversations.addReply(note.id, {
    actor: agent,
    body: "Updated this region in version 2.",
    context: { versionSeq: 2, representation: "media" },
    target: { ...original, versionSeq: 2, locator: { ...original.locator, time: 3.5 } },
    mediaSnapshot: {
      mediaType: "image/png",
      base64: Buffer.from(await Bun.file(join(root, "image-2.png")).arrayBuffer()).toString(
        "base64",
      ),
    },
  });
  await page.command("Page.reload");
  await eventually(
    () => page.evaluate(`!!document.querySelector('[data-compare-reply="${fix.id}"]')`),
    "media Compare action",
  );
  await click(`[data-compare-reply="${fix.id}"]`);
  await eventually(
    () =>
      page.evaluate(
        "document.querySelectorAll('[data-artifact-comparison] img[alt=\"Saved frame\"]').length === 2",
      ),
    "both saved frames shown",
  ).catch(async (error) => {
    await shot("debug-comparison.png");
    console.log(
      await page.evaluate(
        "JSON.stringify({text:document.querySelector('[data-artifact-comparison]')?.innerText, videos:[...document.querySelectorAll('[data-artifact-comparison] video')].map(v=>({ready:v.readyState,paused:v.paused,time:v.currentTime})), images:[...document.querySelectorAll('[data-artifact-comparison] img')].map(i=>({alt:i.alt,loaded:i.complete,width:i.naturalWidth}))})",
      ),
    );
    throw error;
  });
  await shot("02-media-comparison.png");
  for (let i = 0; i < 3; i++)
    await click('[data-comparison-side="original"] [aria-label="Zoom in"]');
  assert.equal(
    await page.evaluate(
      "document.querySelector('[data-comparison-side=\"proposed\"] [data-media-viewport]').dataset.zoom",
    ),
    "1",
  );
  assert.equal(
    await page.evaluate(
      'document.querySelector(\'[data-comparison-side="original"] [aria-label="Pan mode"]\').getAttribute("aria-pressed")',
    ),
    "true",
  );
  const comparisonView = await page.evaluate(
    "(()=>{const r=document.querySelector('[data-comparison-side=\"original\"] [data-media-viewport]').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()",
  );
  await dragPointer(
    { x: comparisonView.x + comparisonView.w * 0.5, y: comparisonView.y + comparisonView.h * 0.5 },
    { x: comparisonView.x + comparisonView.w * 2, y: comparisonView.y + comparisonView.h * 2 },
  );
  assert.equal(
    await page.evaluate(
      "(()=>{const v=document.querySelector('[data-comparison-side=\"original\"] [data-media-viewport]').getBoundingClientRect();const r=document.querySelector('[data-comparison-side=\"original\"] [data-media-transform]').getBoundingClientRect();return r.left<=v.left+.1 && r.top<=v.top+.1 && r.right>=v.right-.1 && r.bottom>=v.bottom-.1})()",
    ),
    true,
  );
  await shot("05-media-zoom.png");
  assert.equal(
    await page.evaluate(
      "document.querySelector('[data-artifact-comparison] [aria-label=\"Add video feedback\"]') === null",
    ),
    true,
  );
  await click('[data-comparison-side="original"] [aria-label="Play video"]');
  await eventually(
    () =>
      page.evaluate(
        "document.querySelector('[data-comparison-side=original] video').currentTime > 2.6",
      ),
    "independent playback",
  );
  assert.equal(
    await page.evaluate("document.querySelector('[data-comparison-side=proposed] video').paused"),
    true,
  );
  await click('[aria-label="Return to targets"]');
  await eventually(
    () =>
      page.evaluate(
        "document.querySelectorAll('[data-artifact-comparison] img[alt=\"Saved frame\"]').length === 2",
      ),
    "return to captured targets",
  );
  assert.equal(
    await page.evaluate(
      '[...document.querySelectorAll("[data-artifact-comparison] [data-media-viewport]")].every(e=>e.dataset.zoom === "1")',
    ),
    true,
  );
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await shot("03-mobile-comparison.png");
  assert.equal(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  assert.equal(
    await page.evaluate(
      '[...document.querySelectorAll("[data-artifact-comparison] [data-media-zoom-controls]")].every(e=>{const r=e.getBoundingClientRect();return !r.width || (r.left>=0 && r.right<=innerWidth)})',
    ),
    true,
  );
  await page.command("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await click('[data-comparison-side="proposed"] [aria-label="Zoom in"]');
  const touchRect = await page.evaluate(
    "(()=>{const r=document.querySelector('[data-comparison-side=\"proposed\"] [data-media-viewport]').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}})()",
  );
  await page.command("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: touchRect.x + touchRect.w * 0.5, y: touchRect.y + touchRect.h * 0.5 }],
  });
  await page.command("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ x: touchRect.x + touchRect.w * 0.6, y: touchRect.y + touchRect.h * 0.55 }],
  });
  await page.command("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  assert.equal(
    await page.evaluate(
      'document.querySelector(\'[data-comparison-side="proposed"] [data-media-transform]\').style.transform.startsWith("translate(0%, 0%)")',
    ),
    false,
  );
  await click('[data-comparison-side="proposed"] [aria-label="Reset zoom"]');
  await page.command("Emulation.setTouchEmulationEnabled", { enabled: false });
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 1536,
    height: 1024,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await click('[aria-label="Return to artifact"]');
  await Bun.sleep(600);
  await eventually(
    () =>
      page.evaluate(
        '!!document.querySelector(\'[data-file="image.png"] [aria-label="Add image feedback"]:not(:disabled)\')',
      ),
    "image ready after returning to artifact",
  );
  await click('[data-file="image.png"] [aria-label="Add image feedback"]');
  await click('[data-file="image.png"] [data-media-selection]');
  await eventually(
    () => page.evaluate("!!document.querySelector('[data-artifact-composer] img')"),
    "still image captured",
  );
  const imageHasBox = () =>
    page.evaluate(
      "!!document.querySelector('[data-file=\"image.png\"] [data-media-frame] [data-media-box]')",
    );
  assert.equal(await imageHasBox(), true, "region remains visible while composing feedback");
  await click('[data-artifact-composer] button:has(+ button[type="submit"])');
  await eventually(async () => !(await imageHasBox()), "cancelling clears image region");
  await click('[data-file="image.png"] [aria-label="Add image feedback"]');
  await click('[data-file="image.png"] [data-media-selection]');
  await eventually(
    () => page.evaluate("!!document.querySelector('[data-artifact-composer] img')"),
    "image recaptured after cancelling",
  );
  assert.equal(await imageHasBox(), true);
  await click("[data-artifact-composer] textarea");
  await page.command("Input.insertText", { text: "Review the whole image." });
  await shot("04-image-feedback.png");
  await click('[data-artifact-composer] button[type="submit"]');
  await eventually(
    async () => storage.conversations.list(artifact.id).length === 2,
    "image feedback saved",
  );
  await eventually(async () => !(await imageHasBox()), "posting clears image region");
  const imageTarget = storage.conversations.list(artifact.id)[1]!.target as ArtifactMediaTarget;
  assert.equal(imageTarget.locator.time, null);
  assert.deepEqual(imageTarget.locator.box, { x: 0, y: 0, width: 1, height: 1 });
  assert.ok(
    await page.evaluate(
      '!!document.querySelector(\'[data-file="image.png"] button[title="Leave feedback on this file"]\')',
    ),
  );
  // Locate shows the immutable snapshot. A new note must capture those visible
  // pixels even when the underlying decoder is at a different frame.
  await click(`[data-artifact-feedback="${note.id}"] button[title*="clip.webm"]`);
  await eventually(
    () =>
      page.evaluate(
        'document.querySelector(\'[data-file="clip.webm"] img[alt="Saved frame"]\')?.naturalWidth === 640',
      ),
    "original saved frame located",
  );
  await page.evaluate("document.querySelector('[data-file=\"clip.webm\"] video').currentTime = 7");
  await click('[data-file="clip.webm"] [aria-label="Add video feedback"]');
  await eventually(
    () => page.evaluate('document.activeElement?.matches("[data-media-selection]")'),
    "targeting surface focused",
  );
  await page.command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await page.command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Enter",
    code: "Enter",
    windowsVirtualKeyCode: 13,
  });
  await eventually(
    () => page.evaluate("!!document.querySelector('[data-artifact-composer] img')"),
    "visible saved frame captured",
  );
  const videoHasBox = () =>
    page.evaluate(
      "!!document.querySelector('[data-file=\"clip.webm\"] [data-media-frame] [data-media-box]')",
    );
  assert.equal(await videoHasBox(), true);
  await click("[data-artifact-composer] textarea");
  await page.command("Input.insertText", { text: "Another note on this exact saved frame." });
  await click('[data-artifact-composer] button[type="submit"]');
  await eventually(
    async () => storage.conversations.list(artifact.id).length === 3,
    "saved-frame feedback posted",
  );
  await eventually(async () => !(await videoHasBox()), "posting clears video region");
  const recaptured = storage.conversations.list(artifact.id)[2]!.target as ArtifactMediaTarget;
  assert.equal(recaptured.locator.time, time);
  assert.equal(recaptured.locator.frame?.hash, acceptedHash);
  console.log(
    "PASS: region capture, exact saved instant, persistent frame draft, posting, agent fix comparison, independent playback, return to targets and mobile geometry",
  );
} finally {
  await browser?.close();
  app.stop(true);
  api.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
