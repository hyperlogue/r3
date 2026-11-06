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
if (!build.success) throw new Error("Browser workspace failed to build");
const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
const js = build.outputs
  .find((output) => output.path.endsWith(".js"))!
  .path.split("/")
  .at(-1)!;
const css = build.outputs
  .find((output) => output.path.endsWith(".css"))
  ?.path.split("/")
  .at(-1);
const root = await mkdtemp(join(tmpdir(), "r3-storage-acceptance-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human" as const, sessionId: null };
const first = storage.artifacts.create({ kind: "html", actor, title: "Storage fixture" });
const second = storage.artifacts.create({ kind: "html", actor, title: "Other storage fixture" });
const child = `<!doctype html><html><head><script>
const initial=localStorage.getItem('theme');
addEventListener('message',event=>{if(event.data?.type==='test-write')localStorage.setItem('child',event.data.value)});
parent.postMessage({type:'test-child-ready',value:initial},'*');
</script></head><body><h2>Expanded viewer</h2></body></html>`;
const source = `<!doctype html><html><head><script>
window.initial=localStorage.getItem('theme');window.readyStorage=true;
window.events=[];window.childReady=[];
addEventListener('storage',event=>events.push({key:event.key,value:event.newValue,area:event.storageArea===localStorage}));
addEventListener('message',event=>{if(event.data?.type==='test-child-ready')childReady.push(event.data.value)});
</script></head><body><h1>Storage fixture</h1><img src="/forbidden-image" alt="Blocked external resource">
<iframe id="static-child" sandbox="allow-scripts allow-downloads" srcdoc="${child.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}"></iframe>
<button id="expand">Expand</button><button id="export">Export</button><a href="other.html">Other document</a>
<script>
document.querySelector('#expand').onclick=()=>{const frame=document.createElement('iframe');frame.id='dynamic-child';frame.sandbox='allow-scripts allow-downloads';document.body.append(frame);frame.srcdoc=${JSON.stringify(child).replaceAll("<", "\\u003c")}};
document.querySelector('#export').onclick=()=>{const a=document.createElement('a');a.download='diagram.txt';a.href=URL.createObjectURL(new Blob(['exported diagram']));document.body.append(a);a.click();a.remove()};
</script><script type="module">import r3 from '/r3/utility.js';window.r3=r3;</script></body></html>`;
for (const artifact of [first, second]) {
  for (const seq of [1, 2])
    await storage.artifacts.publish(artifact.id, {
      actor,
      expectedSeq: seq - 1,
      publicationKey: `fixture-${seq}`,
      content: {
        kind: "html",
        files: [
          {
            path: "index.html",
            mediaType: "text/html",
            base64: Buffer.from(
              artifact.id === second.id ? source.replace("<!doctype html>", "") : source,
            ).toString("base64"),
          },
          {
            path: "other.html",
            mediaType: "text/html",
            base64: Buffer.from(
              '<!doctype html><script>window.readyStorage=true;window.initial=localStorage.getItem("fast")</script><h1>Other document</h1>',
            ).toString("base64"),
          },
        ],
      },
    });
}
const preview = new PreviewHost(storage.artifacts, previewSupport);
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
let forbiddenDownloads = 0;
let forbiddenImages = 0;
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/forbidden-image") {
      forbiddenImages++;
      return new Response('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>', {
        headers: { "content-type": "image/svg+xml" },
      });
    }
    if (path === "/forbidden-download") {
      forbiddenDownloads++;
      return new Response("Outside preview scope", {
        headers: {
          "content-disposition": "attachment; filename=blocked.txt",
          "access-control-allow-origin": "*",
        },
      });
    }
    if (path.startsWith(PREVIEW_PREFIX)) return preview.fetch(request);
    if (path.startsWith("/api/")) return api.app.fetch(request);
    if (path === "/seed")
      return new Response("<!doctype html><title>Seed</title>", {
        headers: { "content-type": "text/html" },
      });
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
  await browser.send("Browser.setDownloadBehavior", {
    behavior: "allow",
    downloadPath: root,
    eventsEnabled: true,
  });
  const downloads: string[] = [];
  browser.listen((event) => {
    if (event.method === "Browser.downloadWillBegin")
      downloads.push(event.params.suggestedFilename);
  });
  const origin = `http://localhost:${app.port}`;
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  await page.command("Page.navigate", { url: `${origin}/seed` });
  await eventually(() => page.evaluate("document.title==='Seed'"), "seed page");
  await page.evaluate(
    `localStorage.setItem('r3-private','application secret');localStorage.setItem(${JSON.stringify(`r3-artifact-storage:${first.id}:theme`)},'dark')`,
  );
  const findContent = async (owner: typeof page) =>
    eventually(async () => {
      for (const context of owner.contexts.values()) {
        if (context.origin !== "://" || !context.auxData?.isDefault) continue;
        const frame = owner.inContext(context.id);
        try {
          if (await frame.evaluate("window.readyStorage===true")) return frame;
        } catch {}
      }
      return null;
    }, "initialized published page");
  const open = async (id = first.id, seq = 1) => {
    await page.command("Page.navigate", { url: `${origin}/${id}?version=${seq}` });
    return findContent(page);
  };
  const held = await page.command("Page.addScriptToEvaluateOnNewDocument", {
    source: `if(window===top){const post=MessagePort.prototype.postMessage;MessagePort.prototype.postMessage=function(value,...args){if(Array.isArray(value?.values)&&!window.storageSnapshotReleased){window.storageSnapshotQueued=true;window.releaseStorageSnapshot=()=>{window.storageSnapshotReleased=true;post.call(this,value,...args)};return}return post.call(this,value,...args)}}`,
  });
  await page.command("Page.navigate", { url: `${origin}/${first.id}?version=1` });
  await eventually(() => page.evaluate("window.storageSnapshotQueued"), "held storage snapshot");
  for (const context of page.contexts.values()) {
    if (context.origin === "://" && context.auxData?.isDefault)
      assert.equal(
        await page.inContext(context.id).evaluate("window.readyStorage===true"),
        false,
        "publisher scripts wait for restored values",
      );
  }
  await page.command("Page.removeScriptToEvaluateOnNewDocument", { identifier: held.identifier });
  await page.evaluate("releaseStorageSnapshot()");
  let content = await findContent(page);
  assert.equal(
    await content.evaluate("initial"),
    "dark",
    "the first publisher script sees restored storage",
  );
  assert.equal(await content.evaluate("document.compatMode"), "CSS1Compat");
  assert.equal(await content.evaluate("globalThis.origin"), "null");
  assert.equal(await content.evaluate("localStorage.getItem('r3-private')"), null);
  assert.equal(
    await content.evaluate("(()=>{try{parent.document;return false}catch{return true}})()"),
    true,
  );
  await eventually(
    () => content.evaluate("childReady.length===1 && childReady[0]==='dark'"),
    "static nested storage",
  );
  await content.evaluate("document.querySelector('#expand').click()");
  await eventually(
    () => content.evaluate("childReady.length===2 && childReady[1]==='dark'"),
    "dynamic expanded storage",
  );
  await content.evaluate(
    "document.querySelector('#dynamic-child').contentWindow.postMessage({type:'test-write',value:'saved from child'},'*')",
  );
  await eventually(
    () => content.evaluate("localStorage.getItem('child')==='saved from child'"),
    "child storage synchronization",
  );
  await content.evaluate(
    "localStorage.setItem('theme','light');localStorage['named']='property';delete localStorage.named",
  );
  await eventually(
    () =>
      page.evaluate(
        `localStorage.getItem(${JSON.stringify(`r3-artifact-storage:${first.id}:theme`)})==='light'`,
      ),
    "native storage persistence",
  );
  content = await open();
  assert.equal(await content.evaluate("initial"), "light");
  assert.equal(await content.evaluate("localStorage.getItem('child')"), "saved from child");
  content = await open(first.id, 2);
  assert.equal(await content.evaluate("initial"), "light", "versions share the artifact namespace");
  const other = await browser.send("Target.createTarget", { url: "about:blank" });
  const otherPage = await browser.attach(other.targetId);
  await otherPage.command("Page.navigate", { url: `${origin}/${first.id}?version=2` });
  const otherContent = await findContent(otherPage);
  await otherContent.evaluate("localStorage.setItem('shared','other tab')");
  await eventually(
    () =>
      content.evaluate(
        "localStorage.getItem('shared')==='other tab' && events.some(e=>e.key==='shared'&&e.area)",
      ),
    "cross-tab storage event",
  );
  assert.equal(
    await content.evaluate(
      "(()=>{try{localStorage.setItem('huge','x'.repeat(256*1024));return false}catch(e){return e.name==='QuotaExceededError'}})()",
    ),
    true,
  );
  await content.evaluate("document.querySelector('#export').click()");
  await eventually(
    () => Promise.resolve(downloads.includes("diagram.txt")),
    "download without r3 consent",
  );
  await content.evaluate(
    "localStorage.setItem('fast','before navigation');location.href='other.html'",
  );
  content = await eventually(async () => {
    const frame = await findContent(page);
    try {
      return (await frame.evaluate("document.querySelector('h1')?.textContent==='Other document'"))
        ? frame
        : null;
    } catch {
      return null;
    }
  }, "native navigation");
  assert.equal(await content.evaluate("initial"), "before navigation");
  content = await open(second.id);
  assert.equal(
    await content.evaluate("document.compatMode"),
    "BackCompat",
    "nested source markup must not supply the outer document's doctype",
  );
  assert.equal(
    await content.evaluate("initial"),
    null,
    "other artifacts cannot see the first namespace",
  );
  await content.evaluate("localStorage.setItem('theme','sibling');localStorage.clear()");
  assert.equal(await content.evaluate("localStorage.length"), 0);
  assert.equal(await page.evaluate("localStorage.getItem('r3-private')"), "application secret");
  content = await open();
  assert.equal(await content.evaluate("initial"), "light");
  await content.evaluate(
    `{const a=document.createElement('a');a.download='blocked.txt';a.href=${JSON.stringify(`${origin}/forbidden-download`)};document.body.append(a);a.click()}`,
  );
  await Bun.sleep(300);
  assert.equal(
    forbiddenDownloads,
    0,
    "downloads cannot open connections outside the scoped preview",
  );
  assert.equal(downloads.includes("blocked.txt"), false);
  assert.equal(forbiddenImages, 0, "preparing nested frames retains the closed resource policy");
  console.log(
    "Preview storage: first-script restoration, nested viewers, reloads, versions, tab synchronization, quota, navigation, isolation and automatic downloads passed",
  );
} finally {
  await browser?.close();
  app.stop(true);
  api.close();
  preview.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
