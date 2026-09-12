import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactApi } from "../server/artifact-api.ts";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import { PreviewHost } from "../server/preview-host.ts";
import { previewSupport } from "../server/preview-support.ts";
import { eventually, openTestBrowser } from "./browser.ts";
import { browserLoweredCssPlugin } from "./spa-css.ts";

const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "preview-workspace-fixture.tsx")],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [await browserLoweredCssPlugin()],
});
if (!build.success) throw new Error("Browser acceptance workspace failed to build");
const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
const js = build.outputs
  .find((output) => output.path.endsWith(".js"))!
  .path.split("/")
  .at(-1)!;
const css = build.outputs
  .find((output) => output.path.endsWith(".css"))
  ?.path.split("/")
  .at(-1);
const root = await mkdtemp(join(tmpdir(), "r3-workspace-acceptance-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human" as const, sessionId: null };
const artifact = storage.artifacts.create({ kind: "html", actor, title: "Published workspace" });
const source =
  '<!doctype html><html><head><title>Published fixture</title></head><body><h1 id="heading">Published first version</h1><p id="output">Ready</p><button id="send">Request revision</button><a href="other.html">Other document</a><script type="module">import r3 from "/r3/utility.js";send.onclick=async()=>{try{const note=await r3.createFeedback({body:"Please revise this chart",locator:{selector:"#heading",quote:document.querySelector("h1").textContent}});window.lastFeedback=note.id;output.textContent="Sent: "+note.id;}catch(error){output.textContent=error.message}};window.r3=r3;</script></body></html>';
for (const seq of [1, 2])
  await storage.artifacts.publish(artifact.id, {
    actor,
    expectedSeq: seq - 1,
    publicationKey: `publication-${seq}`,
    content: {
      kind: "html",
      files: [
        {
          path: "index.html",
          mediaType: "text/html",
          base64: Buffer.from(
            seq === 1 ? source : source.replace("first version", "second version"),
          ).toString("base64"),
        },
        {
          path: "other.html",
          mediaType: "text/html",
          base64: Buffer.from(
            '<!doctype html><h1>Other published document</h1><a href="index.html">Back</a>',
          ).toString("base64"),
        },
      ],
    },
  });
let preview: PreviewHost;
const resources = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => preview.fetch(request),
});
preview = new PreviewHost(storage.artifacts, `http://localhost:${resources.port}`, previewSupport);
const api = createArtifactApi(
  storage,
  {
    token: randomBytes(32).toString("base64url"),
    requireLogin: false,
    version: "acceptance",
    allowedHost: (host) => host === "localhost",
  },
  { previews: preview },
);
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
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
  await page.command("Page.navigate", { url: `http://localhost:${app.port}/?version=1` });
  const content = await eventually(async () => {
    const context = [...page.contexts.values()].find(
      (context) => context.origin.includes(".localhost:") && context.auxData?.isDefault,
    );
    if (!context) return null;
    const frame = page.inContext(context.id);
    try {
      return (await frame.evaluate("!!window.r3")) ? frame : null;
    } catch {
      return null;
    }
  }, "workspace published preview");
  assert.equal(
    await content.evaluate("document.querySelector('h1').textContent"),
    "Published first version",
  );
  assert.equal(
    await page.evaluate("!!document.querySelector('[data-artifact-preview] iframe')"),
    true,
  );
  assert.equal(await content.evaluate("r3.getContext().then(c=>c.versionSeq)"), 1);
  assert.equal(
    await content.evaluate("r3.createFeedback({body:'Automatic'}).then(()=>false,()=>true)"),
    true,
    "page load alone must not send feedback",
  );
  // Trusted pointer input activates the real embedded control and its parent.
  const click = async (expression: string) => {
    const position = await page.evaluate(
      `(()=>{const r=(${expression}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    );
    await page.command("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...position,
    });
    await page.command("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...position,
    });
  };
  const offset = await page.evaluate(
    "(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.x,y:r.y}})()",
  );
  const rect = await content.evaluate(
    "(()=>{const r=document.querySelector('#send').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()",
  );
  for (const type of ["mousePressed", "mouseReleased"])
    await page.command("Input.dispatchMouseEvent", {
      type,
      button: "left",
      clickCount: 1,
      x: offset.x + rect.x,
      y: offset.y + rect.y,
    });
  const feedbackId = await eventually(
    () => content.evaluate("window.lastFeedback"),
    "utility feedback creation",
  );
  const feedback = storage.conversations
    .list(artifact.id)
    .find((feedback) => feedback.id === feedbackId)!;
  assert.equal(feedback.author.role, "human");
  assert.deepEqual(feedback.target, {
    kind: "rendered",
    versionSeq: 1,
    path: "index.html",
    locator: { selector: "#heading", quote: "Published first version" },
  });
  await eventually(
    () => page.evaluate("document.body.textContent.includes('Please revise this chart')"),
    "same thread in the feedback panel",
  );
  await click(
    "Array.from(document.querySelectorAll('button')).find(b=>b.getAttribute('aria-label')==='Next published version')",
  );
  const next = await eventually(async () => {
    for (const context of page.contexts.values()) {
      if (!context.origin.includes(".localhost:") || !context.auxData?.isDefault) continue;
      const frame = page.inContext(context.id);
      try {
        if (
          await frame.evaluate(
            "!!window.r3 && document.querySelector('h1')?.textContent==='Published second version'",
          )
        )
          return frame;
      } catch {
        /* The old context can disappear during the switch. */
      }
    }
    return null;
  }, "second immutable version");
  assert.equal(await next.evaluate("r3.getContext().then(c=>c.versionSeq)"), 2);
  await click("document.querySelector('[data-artifact-feedback] button')");
  const original = await eventually(async () => {
    for (const context of page.contexts.values()) {
      if (!context.origin.includes(".localhost:") || !context.auxData?.isDefault) continue;
      const frame = page.inContext(context.id);
      try {
        if (
          await frame.evaluate(
            "!!CSS.highlights.get('r3-preview-active') && document.querySelector('h1')?.textContent==='Published first version'",
          )
        )
          return frame;
      } catch {
        /* Locate replaces the preview origin. */
      }
    }
    return null;
  }, "Locate opens and highlights the original published target");
  const originalOrigin = await original.evaluate<string>("location.origin");
  await original.evaluate("document.querySelector('a').click()");
  await eventually(async () => {
    for (const context of page.contexts.values()) {
      if (context.origin !== originalOrigin || !context.auxData?.isDefault) continue;
      try {
        if (
          await page
            .inContext(context.id)
            .evaluate("document.querySelector('h1')?.textContent==='Other published document'")
        )
          return true;
      } catch {
        /* Native document navigation replaces its JS context. */
      }
    }
    return false;
  }, "version-local document navigation retains its preview origin");
  await eventually(
    () => page.evaluate("new URL(location.href).searchParams.get('file')==='other.html'"),
    "workspace deep link follows the published document",
  );
  const screenshot = process.env.R3_TEST_SCREENSHOT;
  if (screenshot) {
    const image = await page.command("Page.captureScreenshot", { format: "png" });
    await Bun.write(screenshot, Buffer.from(image.data, "base64"));
  }
  console.log(
    "Preview workspace acceptance: isolated render, human utility, shared thread, version switching, native Locate, and document navigation passed",
  );
} finally {
  await browser?.close();
  app.stop(true);
  resources.stop(true);
  api.close();
  preview.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
