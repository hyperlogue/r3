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
  '<!doctype html><html><head><title>Published fixture</title></head><body><h1 id="heading">Published first version</h1><p id="output">Ready</p><button id="send">Request revision</button><a href="other.html">Other document</a><script type="module">import r3 from "/r3/utility.js";send.onclick=async()=>{try{await r3.setTheme("dark");const note=await r3.createDiscussion({body:"Please revise this chart",locator:{selector:"#heading",quote:document.querySelector("h1").textContent}});window.lastDiscussion=note.id;output.textContent="Sent: "+note.id;}catch(error){output.textContent=error.message}};window.r3=r3;</script></body></html>';
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
    if (path.startsWith(PREVIEW_PREFIX)) return preview.fetch(request);
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
  const initialHistory = await page.evaluate<number>("history.length");
  await page.command("Page.navigate", { url: `http://localhost:${app.port}/?version=1` });
  const content = await eventually(async () => {
    const context = [...page.contexts.values()].find(
      (context) => context.origin === "://" && context.auxData?.isDefault,
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
    await page.evaluate("history.length"),
    initialHistory + 1,
    "Opening a preview must not add a history entry for its verification gate",
  );
  assert.equal(
    await page.evaluate("!!document.querySelector('[data-artifact-preview] iframe')"),
    true,
  );
  assert.equal(await content.evaluate("r3.getContext().then(c=>c.versionSeq)"), 1);
  assert.equal(await content.evaluate("r3.getTheme()"), null);
  assert.equal(
    await content.evaluate("r3.setTheme('dark').then(()=>false,()=>true)"),
    true,
    "page load alone cannot persist theme choices",
  );
  assert.equal(
    await content.evaluate(
      "(()=>{try {localStorage.getItem('r3-theme');return false;}catch{return true;}})()",
    ),
    true,
    "theme persistence retains opaque storage isolation",
  );
  assert.equal(
    await content.evaluate("r3.createDiscussion({body:'Automatic'}).then(()=>false,()=>true)"),
    true,
    "page load alone must not send discussions",
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
  const discussionId = await eventually(
    () => content.evaluate("window.lastDiscussion"),
    "utility discussions creation",
  );
  assert.equal(await content.evaluate("r3.getTheme()"), "dark");
  assert.equal(
    await page.evaluate("localStorage.getItem('r3-theme')"),
    null,
    "the artifact cannot change the application theme",
  );
  const discussions = storage.conversations
    .list(artifact.id)
    .find((discussions) => discussions.id === discussionId)!;
  assert.equal(discussions.comments[0]!.author.role, "human");
  assert.deepEqual(discussions.target, {
    kind: "rendered",
    versionSeq: 1,
    path: "index.html",
    locator: { selector: "#heading", quote: "Published first version" },
  });
  await eventually(
    () => page.evaluate("document.body.textContent.includes('Please revise this chart')"),
    "same thread in the discussions panel",
  );
  await click("document.querySelector('[aria-label=\"Published version\"]')");
  await click("document.querySelector('[data-version-seq=\"2\"]')");
  const next = await eventually(async () => {
    for (const context of page.contexts.values()) {
      if (context.origin !== "://" || !context.auxData?.isDefault) continue;
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
  assert.equal(await next.evaluate("r3.getTheme()"), "dark", "theme survives version switching");
  await next.evaluate("window.beforeThemeReload = true");
  await page.command("Page.reload");
  await eventually(async () => {
    for (const context of page.contexts.values()) {
      if (context.origin !== "://" || !context.auxData?.isDefault) continue;
      try {
        if (
          await page
            .inContext(context.id)
            .evaluate(
              "(async()=>!window.beforeThemeReload && !!window.r3 && (await r3.getTheme()) === 'dark')()",
            )
        )
          return true;
      } catch {
        /* Preview setup can replace the document. */
      }
    }
    return false;
  }, "theme survives reloading the workspace");
  await click("document.querySelector('[data-artifact-discussions] button')");
  const original = await eventually(async () => {
    for (const context of page.contexts.values()) {
      if (context.origin !== "://" || !context.auxData?.isDefault) continue;
      const frame = page.inContext(context.id);
      try {
        if (
          await frame.evaluate(
            "!!CSS.highlights.get('r3-preview-active') && document.querySelector('h1')?.textContent==='Published first version'",
          )
        )
          return frame;
      } catch {
        /* Locate replaces the preview document. */
      }
    }
    return null;
  }, "Locate opens and highlights the original published target");
  const beforeLink = await page.evaluate<number>("history.length");
  assert.equal(beforeLink, initialHistory + 1, "Version changes and Locate add no setup entries");
  const originalRoot = await original.evaluate<string>("r3.getContext().then(c=>c.resourceRoot)");
  await original.evaluate("document.querySelector('a').click()");
  await eventually(async () => {
    for (const context of page.contexts.values()) {
      if (context.origin !== "://" || !context.auxData?.isDefault) continue;
      try {
        if (
          await page
            .inContext(context.id)
            .evaluate(
              `location.href.startsWith(${JSON.stringify(originalRoot)}) && globalThis.origin === "null" && document.querySelector('h1')?.textContent==='Other published document'`,
            )
        )
          return true;
      } catch {
        /* Native document navigation replaces its JS context. */
      }
    }
    return false;
  }, "version-local document navigation retains its version scope");
  await eventually(
    () => page.evaluate("new URL(location.href).searchParams.get('file')==='other.html'"),
    "workspace deep link follows the published document",
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
      () =>
        page.evaluate(`new URL(location.href).searchParams.get('file')===${JSON.stringify(path)}`),
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
    assert.equal(
      await page.evaluate("new URL(location.href).searchParams.get('file')"),
      "other.html",
    );
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
    await eventually(async () => {
      for (const context of page.contexts.values()) {
        if (context.origin !== "://" || !context.auxData?.isDefault) continue;
        try {
          if (
            await page
              .inContext(context.id)
              .evaluate(`document.querySelector('h1')?.textContent === ${JSON.stringify(text)}`)
          )
            return true;
        } catch {
          /* Navigation replaces the old execution context. */
        }
      }
      return false;
    }, "selected version returns to its published root page");
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
    "Preview workspace acceptance: isolated render, human utility, shared thread, version switching, native Locate, document navigation, and context recovery passed",
  );
} finally {
  await browser?.close();
  app.stop(true);
  api.close();
  preview.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
