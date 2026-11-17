import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactApi } from "../server/artifact-api.ts";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import { PREVIEW_PREFIX } from "../server/preview-contexts.ts";
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
  '<!doctype html><html><head><title>Published fixture</title></head><body><h1 id="heading">Published first version</h1><p id="output">Ready</p><button id="send">Request revision</button><a href="other.html">Other document</a><script type="module">import r3 from "/r3/utility.js";send.onclick=async()=>{try{const note=await r3.createThread({body:"Please revise this chart",locator:{selector:"#heading",quote:document.querySelector("h1").textContent}});window.lastThread=note.id;output.textContent="Sent: "+note.id;}catch(error){output.textContent=error.message}};window.r3=r3;</script></body></html>';
for (const seq of [1, 2])
  await storage.artifacts.publish(artifact.id, {
    actor,
    expectedSeq: seq - 1,
    publicationKey: `publication-${seq}`,
    content: {
      kind: "html",
      files: [
        {
          path: "models/test.bin",
          mediaType: "application/octet-stream",
          base64: Buffer.from([0, 255, seq]).toString("base64"),
        },
        {
          path: "assets/test.svg",
          mediaType: "image/svg+xml",
          base64: btoa('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"/>'),
        },
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
let previewTime = Date.now();
const preview = new PreviewHost(storage.artifacts, previewSupport, () => previewTime);
let previewCreations = 0;
let previewRenewals = 0;
let previewGates = 0;
let renewalFailure = 0;
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
const reads: { path: string; status: number }[] = [];
const nativeAssetRequests: string[] = [];
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/r3/gate")) previewGates++;
    if (request.method === "POST" && path.endsWith("/previews")) previewCreations++;
    if (request.method === "PATCH" && path.startsWith("/api/previews/")) {
      previewRenewals++;
      if (renewalFailure)
        return Response.json({ error: "Renewal denied by fixture" }, { status: renewalFailure });
    }
    if (path.startsWith(PREVIEW_PREFIX)) {
      if (path.endsWith("/assets/test.svg") || path.endsWith("/models/test.bin"))
        nativeAssetRequests.push(path);
      return preview.fetch(request);
    }
    if (path.startsWith("/api/")) {
      const response = await api.app.fetch(request);
      if (path.endsWith("/resource"))
        reads.push({
          path: new URL(request.url).searchParams.get("path")!,
          status: response.status,
        });
      return response;
    }
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
  const initialHistory = await page.evaluate<number>("history.length");
  await page.command("Page.navigate", { url: `http://localhost:${app.port}/?version=1` });
  const attached = new Map<string, Awaited<ReturnType<typeof browser.attach>>>();
  const findContent = (expression: string, description: string) =>
    eventually(async () => {
      const frames = [...page.contexts.values()]
        .filter((context) => context.origin === "://" && context.auxData?.isDefault)
        .map((context) => page.inContext(context.id));
      const targets = (await browser!.send("Target.getTargets")).targetInfos;
      for (const target of targets) {
        if (
          target.type !== "iframe" ||
          !target.url.startsWith(`http://localhost:${app.port}${PREVIEW_PREFIX}`) ||
          !target.url.includes("/files/")
        )
          continue;
        try {
          const frame = attached.get(target.targetId) ?? (await browser!.attach(target.targetId));
          attached.set(target.targetId, frame);
          frames.push(frame);
        } catch {
          // A navigation can replace the target before attachment.
        }
      }
      for (const frame of frames) {
        try {
          if (await frame.evaluate(expression)) return frame;
        } catch {
          // A navigation can replace the execution context before evaluation.
        }
      }
      return null;
    }, description);
  let content = await findContent("!!window.r3", "workspace published preview");
  assert.equal(
    await content.evaluate("document.querySelector('h1').textContent"),
    "Published first version",
  );
  assert.equal(
    await page.evaluate("history.length"),
    initialHistory + 1,
    "Opening a preview must not add a history entry for its verification gate",
  );
  assert.equal(
    await page.evaluate("!!document.querySelector('[data-artifact-preview] iframe')"),
    true,
  );
  assert.equal(await content.evaluate("r3.getContext().then(c=>c.versionSeq)"), 1);
  assert.equal(
    await content.evaluate(
      "(()=>{try {Storage.prototype.getItem.call(localStorage,'r3-theme');return false;}catch{return true;}})()",
    ),
    true,
    "publisher storage retains opaque isolation",
  );
  assert.equal(
    await content.evaluate("r3.createThread({body:'Automatic'}).then(()=>false,()=>true)"),
    true,
    "page load alone must not send threads",
  );
  const modelBytes = `Promise.all([r3.readAsset("models/test.bin"), r3.readAsset("models/test.bin")]).then(async ([a,b])=>[a.type,[...new Uint8Array(await b.arrayBuffer())]])`;
  assert.deepEqual(await content.evaluate(modelBytes), ["application/octet-stream", [0, 255, 1]]);
  for (const path of ["missing.bin", "/api/boot", "../index.html", "https://example.invalid/x"]) {
    assert.equal(
      await content.evaluate(
        `r3.readAsset(${JSON.stringify(path)}).then(()=>false,e=>e.message.includes("not a published file"))`,
      ),
      true,
    );
  }
  assert.deepEqual(reads, [{ path: "models/test.bin", status: 200 }]);
  await content.evaluate(`(() => {
    const img=window.boundImage=new Image(32,16);
    img.style.cssText="position:fixed;top:200vh";
    window.releaseImage=r3.bindImage(img,"assets/test.svg");
    document.body.append(img);
    return new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(true))));
  })()`);
  assert.equal(reads.length, 1, "offscreen dynamic images reserve space without a download");
  assert.equal(await content.evaluate(`boundImage.getBoundingClientRect().width`), 32);
  await content.evaluate(`boundImage.style.top="10px"`);
  await eventually(() => content.evaluate("boundImage.naturalWidth===32"), "visible dynamic image");
  assert.deepEqual(reads.at(-1), { path: "assets/test.svg", status: 200 });
  await content.evaluate("releaseImage()");
  assert.equal(await content.evaluate("boundImage.hasAttribute('src')"), false);
  await content.evaluate("window.beforeAssetReload = true");
  await page.command("Page.reload");
  content = await findContent(
    "!!window.r3 && !window.beforeAssetReload",
    "fresh preview after reload",
  );
  assert.deepEqual(await content.evaluate(modelBytes), ["application/octet-stream", [0, 255, 1]]);
  assert.deepEqual(
    reads.at(-1),
    { path: "models/test.bin", status: 304 },
    "warm model read transfers no body",
  );
  assert.deepEqual(
    await content.evaluate(`(async () => {
    const img = new Image();
    img.loading = "eager";
    let errors = 0;
    img.onerror = () => errors++;
    const loaded = new Promise(resolve => img.onload = resolve);
    const releaseOld = r3.bindImage(img, "missing.svg");
    const release = r3.bindImage(img, "assets/test.svg");
    releaseOld();
    await loaded;
    const width = img.naturalWidth;
    release();
    const failed = new Promise(resolve => img.onerror = () => resolve(true));
    const releaseMissing = r3.bindImage(img, "missing.svg");
    await failed;
    releaseMissing();
    return [width, errors, img.hasAttribute("src")];
  })()`),
    [32, 0, false],
  );
  assert.deepEqual(reads.slice(1), [
    { path: "assets/test.svg", status: 200 },
    { path: "models/test.bin", status: 304 },
    { path: "assets/test.svg", status: 304 },
  ]);
  assert.deepEqual(
    nativeAssetRequests,
    [],
    "bound images and model reads avoid a second request from the preview",
  );
  // Trusted pointer input activates the real embedded control and its parent.
  const click = async (expression: string) => {
    const position = await eventually(
      () =>
        page.evaluate(`(async () => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const element = (${expression});
        if (!element) return null;
        const rect = element.getBoundingClientRect();
        const x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
        return element.contains(document.elementFromPoint(x, y)) ? {x, y} : null;
      })()`),
      "workspace control ready for pointer input",
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
  const threadId = await eventually(
    () => content.evaluate("window.lastThread"),
    "utility threads creation",
  );
  const threads = storage.conversations
    .list(artifact.id)
    .find((threads) => threads.id === threadId)!;
  assert.equal(threads.comments[0]!.author.role, "human");
  assert.deepEqual(threads.target, {
    kind: "rendered",
    versionSeq: 1,
    path: "index.html",
    locator: { selector: "#heading", quote: "Published first version" },
  });
  await eventually(
    () => page.evaluate("document.body.textContent.includes('Please revise this chart')"),
    "same thread in the discussion panel",
  );
  await click("document.querySelector('[aria-label=\"Published version\"]')");
  await click("document.querySelector('[data-version-seq=\"2\"]')");
  const next = await findContent(
    "!!window.r3 && document.querySelector('h1')?.textContent==='Published second version'",
    "second immutable version",
  );
  assert.equal(await next.evaluate("r3.getContext().then(c=>c.versionSeq)"), 2);
  assert.deepEqual(await next.evaluate(modelBytes), ["application/octet-stream", [0, 255, 2]]);
  await next.evaluate("window.beforeReload = true");
  await page.command("Page.reload");
  await findContent(
    "!window.beforeReload && !!window.r3 && typeof r3.getThreads === 'function'",
    "utility returns after reloading the workspace",
  );
  await click("document.querySelector('[data-thread-action=\"locations\"]')");
  await click("document.querySelector('[data-thread-action=\"original\"]')");
  const original = await findContent(
    "!!CSS.highlights.get('r3-preview-active') && document.querySelector('h1')?.textContent==='Published first version'",
    "Locate opens and highlights the original published target",
  );
  const beforeLink = await page.evaluate<number>("history.length");
  assert.equal(beforeLink, initialHistory + 1, "Version changes and Locate add no setup entries");
  const originalRoot = await original.evaluate<string>("r3.getContext().then(c=>c.resourceRoot)");
  await original.evaluate("document.querySelector('a').click()");
  await findContent(
    `location.href.startsWith(${JSON.stringify(originalRoot)}) && globalThis.origin === "null" && document.querySelector('h1')?.textContent==='Other published document'`,
    "version-local document navigation retains its version scope",
  );
  const workspacePath = () =>
    page.evaluate<string>(
      `JSON.parse(sessionStorage.getItem('r3-workspace-selections-1')??'[]').find(([id])=>id===${JSON.stringify(artifact.id)})?.[1].path`,
    );
  await eventually(
    async () => (await workspacePath()) === "other.html",
    "workspace selection follows the published document",
  );
  assert.equal(
    await page.evaluate("history.length"),
    beforeLink + 1,
    "Native links retain history",
  );
  for (const [direction, path] of [
    ["back", "index.html"],
    ["forward", "other.html"],
  ] as const) {
    await page.evaluate(`history.${direction}()`);
    await eventually(
      async () => (await workspacePath()) === path,
      `Native ${direction} updates the workspace path`,
    );
    assert.equal(
      await page.evaluate("history.length"),
      beforeLink + 1,
      "Traversal adds no entries",
    );
  }
  const visiblePreview = () =>
    page.evaluate<string | null>(
      "document.querySelector('[data-artifact-preview] iframe:not([inert])')?.src ?? null",
    );
  const resume = () =>
    page.evaluate(
      "(()=>{for(let i=0;i<3;i++) document.dispatchEvent(new Event('visibilitychange'))})()",
    );
  assert.equal(await page.evaluate("document.visibilityState"), "visible");
  for (const cause of ["expiry", "server restart"] as const) {
    const previousUrl = await eventually(visiblePreview, "preview before suspension");
    const creations = previewCreations;
    const renewals = previewRenewals;
    const gates = previewGates;
    const historyLength = await page.evaluate("history.length");
    if (cause === "expiry") previewTime += 61 * 60000;
    else preview.close();
    const expired = await preview.fetch(
      new Request(previousUrl, { headers: { host: `localhost:${app.port}` } }),
    );
    assert.equal(await expired.text(), "Preview context expired or unavailable");
    await resume();
    const replacement = await eventually(async () => {
      const url = await visiblePreview();
      return url && url !== previousUrl ? url : null;
    }, `automatic preview recovery after ${cause}`);
    assert.equal(new URL(replacement).pathname.endsWith("/files/other.html"), true);
    assert.equal(previewCreations, creations + 1, "Recovery creates one replacement context");
    assert.ok(
      previewRenewals > renewals && previewRenewals <= renewals + 2,
      "Wake events share one renewal, with at most one extra check of a retained context",
    );
    assert.equal(previewGates, gates + 1, "The replacement repeats the capability gate");
    assert.equal(await page.evaluate("history.length"), historyLength);
    assert.equal(await page.evaluate("new URL(location.href).searchParams.get('version')"), "1");
    assert.equal(await workspacePath(), "other.html");
    assert.equal(
      await page.evaluate(
        "document.body.textContent.includes('Preview context expired or unavailable')",
      ),
      false,
    );
  }
  // Explicit version choices use that publication's root page, including
  // after native navigation to a companion document in the preceding version.
  for (const [seq, path, text] of [
    [3, "index.html", "Third HTML version"],
    [4, "index.html", "HTML entrypoint"],
  ] as const) {
    await storage.artifacts.publish(artifact.id, {
      actor,
      expectedSeq: seq - 1,
      publicationKey: `entrypoint-${seq}`,
      content: {
        kind: "html",
        files: [
          {
            path,
            mediaType: "text/html",
            base64: Buffer.from(`<!doctype html><h1>${text}</h1>`).toString("base64"),
          },
        ],
      },
    });
    api.collaboration.broadcast({ type: "version-published", artifactId: artifact.id, seq });
    await eventually(
      () => page.evaluate(`!!document.querySelector('[data-version-seq="${seq}"]')`),
      "new entrypoint version announced",
    );
    await click("document.querySelector('[aria-label=\"Published version\"]')");
    await click(`document.querySelector('[data-version-seq="${seq}"]')`);
    await findContent(
      `document.querySelector('h1')?.textContent === ${JSON.stringify(text)}`,
      "selected version returns to its published root page",
    );
  }
  for (const status of [401, 403, 500]) {
    await eventually(visiblePreview, "preview before renewal failure");
    const creations = previewCreations;
    renewalFailure = status;
    await resume();
    await eventually(
      () => page.evaluate("document.body.textContent.includes('Renewal denied by fixture')"),
      `renewal ${status} stays visible without recreating the context`,
    );
    assert.equal(previewCreations, creations);
    assert.equal(await visiblePreview(), null);
    renewalFailure = 0;
    await page.evaluate(
      "[...document.querySelectorAll('button')].find(button=>button.textContent==='Retry preview').click()",
    );
  }
  await eventually(visiblePreview, "manual recovery after renewal failure");
  const screenshot = process.env.R3_TEST_SCREENSHOT;
  if (screenshot) {
    const image = await page.command("Page.captureScreenshot", { format: "png" });
    await Bun.write(screenshot, Buffer.from(image.data, "base64"));
  }
  console.log(
    "Preview workspace acceptance: isolated render, cached assets, dynamic images, human utility, shared thread, version switching, native Locate, document navigation, and context recovery passed",
  );
} finally {
  await browser?.close();
  app.stop(true);
  api.close();
  preview.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
