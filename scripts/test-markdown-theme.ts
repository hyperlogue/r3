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
const artifact = storage.artifacts.create({ kind: "files", actor, title: "Markdown appearance" });
await storage.artifacts.publish(artifact.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "appearance",
  content: {
    kind: "files",
    files: [
      {
        path: "index.md",
        mediaType: "text/markdown",
        base64: Buffer.from(
          "# Published Markdown\n\nReadable body text.\n\n```ts\nconst value = 42;\n```\n\n" +
            Array.from(
              { length: 30 },
              (_, index) =>
                `## Section ${index + 1}\n\nA long published document should expand in the file stack. Its paragraphs wrap as the file panel changes width, keeping every section readable in the main content scroll pane.`,
            ).join("\n\n"),
        ).toString("base64"),
      },
      {
        path: "page.html",
        mediaType: "text/html",
        base64: Buffer.from(
          '<!doctype html><html><body style="background:rgb(255,192,203);color:rgb(80,0,80)"><h1>Publisher HTML</h1></body></html>',
        ).toString("base64"),
      },
    ],
  },
});
const retainedHash = storage.artifacts.file(artifact.id, 1, "index.md").renderedHash;
const lastSection = await storage.conversations.add(artifact.id, {
  actor,
  body: "Check the last section",
  target: {
    kind: "rendered",
    versionSeq: 1,
    path: "index.md",
    locator: { selector: "h2:nth-of-type(30)", quote: "Section 30" },
  },
});
const preview = new PreviewHost(storage.artifacts, undefined, {
  ...previewSupport,
  runtime: (scope) => {
    // Hold the first height report so cold Locate cannot accidentally pass
    // merely because sizing beats the target message on a fast machine.
    const runtime = previewSupport.runtime(scope);
    assert.ok(runtime.includes("const getUserMedia ="));
    return runtime.replace(
      "const getUserMedia =",
      `
      const send = connection.send;
      let delayedHeight = false;
      connection.send = message => {
        if (message.type === 'r3-preview-height' && !delayedHeight) {
          delayedHeight = true;
          setTimeout(() => send(message), 200);
        } else send(message);
      };
      const getUserMedia =`,
    );
  },
});
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
    if (path.startsWith(PREVIEW_PREFIX)) return preview.fetch(request);
    if (path.startsWith("/api/")) return api.app.fetch(request);
    const asset = assets.get(path.slice(1));
    if (asset) return new Response(asset);
    return new Response(
      `<!doctype html><html class="dark"><head>${css ? `<link rel="stylesheet" href="/${css}">` : ""}<style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style></head><body><div id="root"></div><script type="module" src="/${js}"></script></body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
let browser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
try {
  browser = await openTestBrowser();
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  await page.command("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-color-scheme", value: "dark" }],
  });
  await page.command("Page.navigate", { url: `http://localhost:${app.port}/?version=1` });
  await eventually(
    () =>
      page.evaluate(
        "Array.from(document.querySelectorAll('button')).some(b=>b.textContent.trim()==='Rendered')",
      ),
    "published file headers",
  );
  await page.evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Rendered').click()",
  );
  const markdown = await eventually(async () => {
    for (const context of page.contexts.values()) {
      if (!context.auxData?.isDefault || context.origin !== "://") continue;
      const frame = page.inContext(context.id);
      try {
        if (
          await frame.evaluate("document.querySelector('h1')?.textContent === 'Published Markdown'")
        )
          return frame;
      } catch {}
    }
    return null;
  }, "rendered Markdown");
  const colors = () =>
    markdown.evaluate<{ foreground: string; background: string }>(
      "({foreground:getComputedStyle(document.body).color,background:getComputedStyle(document.body).backgroundColor})",
    );
  const fullHeight = async () => {
    const size = await markdown.evaluate<{ body: number; content: number; viewport: number }>(
      "({body:document.body.getBoundingClientRect().height,content:document.scrollingElement.scrollHeight,viewport:document.documentElement.clientHeight})",
    );
    return size.content <= size.viewport + 1 && Math.abs(size.body - size.viewport) <= 1;
  };
  await eventually(
    fullHeight,
    "rendered Markdown expands to its full height without inner scrolling",
  );
  const narrowHeight = await markdown.evaluate<number>("innerHeight");
  await page.evaluate("document.querySelector('[aria-label=\"Hide feedback\"]').click()");
  await eventually(
    async () =>
      (await fullHeight()) && (await markdown.evaluate<number>("innerHeight")) < narrowHeight,
    "widening Markdown shrinks its frame without a blank tail",
  );
  const wideHeight = await markdown.evaluate<number>("innerHeight");
  await page.evaluate("document.querySelector('[aria-label=\"Show feedback\"]').click()");
  await Bun.sleep(250);
  await eventually(
    async () =>
      (await fullHeight()) && (await markdown.evaluate<number>("innerHeight")) > wideHeight,
    "narrowing Markdown expands its frame again",
  );
  const beforeImageHeight = await markdown.evaluate<number>("innerHeight");
  await markdown.evaluate(`new Promise(resolve => {
    const image = document.createElement('img');
    image.id = 'late-image';
    image.onload = () => resolve(true);
    image.src = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="500"><rect width="200" height="500" fill="gray"/></svg>');
    document.querySelector('main').append(image);
  })`);
  await eventually(
    async () =>
      (await fullHeight()) &&
      (await markdown.evaluate<number>("innerHeight")) > beforeImageHeight + 400,
    "a late-loading image expands the Markdown card",
  );
  const imageHeight = await markdown.evaluate<number>("innerHeight");
  await markdown.evaluate("document.querySelector('#late-image').remove()");
  await eventually(
    async () =>
      (await fullHeight()) && (await markdown.evaluate<number>("innerHeight")) < imageHeight - 400,
    "removing late content restores the natural document height",
  );
  await markdown.evaluate(
    "document.querySelector('h2:last-of-type').scrollIntoView({block:'center'})",
  );
  await eventually(
    () => page.evaluate("document.querySelector('[data-artifact-content]').scrollTop > 1000"),
    "native Markdown targets scroll the outer file stack",
  );
  await page.evaluate(
    "document.querySelector('[data-artifact-content]').scrollTop = 1000; document.querySelector('[aria-label=\"Comment mode\"]').click()",
  );
  await Bun.sleep(100);
  await markdown.evaluate("document.querySelector('main').click()");
  await markdown.command("DOM.enable");
  const document = await markdown.command("DOM.getDocument", { depth: -1, pierce: true });
  const findButton = (node: any, label: string): any =>
    node.nodeName === "BUTTON" && node.children?.some((child: any) => child.nodeValue === label)
      ? node
      : [
          ...(node.children ?? []),
          ...(node.shadowRoots ?? []),
          ...(node.contentDocument ? [node.contentDocument] : []),
        ]
          .map((child) => findButton(child, label))
          .find(Boolean);
  const button = findButton(document.root, "Comment here");
  assert.ok(button);
  const resolved = await markdown.command("DOM.resolveNode", { nodeId: button.nodeId });
  const visibleControls = async () => {
    const result = await markdown.command("Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration:
        "function(){const r=this.parentElement.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height}}",
      returnByValue: true,
    });
    const rect = result.result.value;
    const outer = await page.evaluate(
      "(()=>{const f=document.querySelector('iframe').getBoundingClientRect();const p=document.querySelector('[data-artifact-content]').getBoundingClientRect();return {frameTop:f.top,top:p.top,bottom:p.bottom}})()",
    );
    return (
      rect.height > 0 &&
      rect.top + outer.frameTop >= outer.top &&
      rect.bottom + outer.frameTop <= outer.bottom
    );
  };
  await eventually(
    visibleControls,
    "comment controls stay inside the visible part of a full-height document",
  );
  await page.evaluate("document.querySelector('[data-artifact-content]').scrollTop += 500");
  await eventually(visibleControls, "comment controls remain reachable after outer scrolling");
  await page.evaluate("document.querySelector('[aria-label=\"Exit comment mode\"]').click()");
  await page.evaluate("document.querySelector('[data-artifact-content]').scrollTop = 0");
  await page.evaluate(
    `document.querySelector('[data-artifact-feedback="${lastSection.id}"] button').click()`,
  );
  await Bun.sleep(300);
  assert.ok(
    await page.evaluate("document.querySelector('[data-artifact-content]').scrollTop > 1000"),
    "feedback Locate must keep the deep Markdown target visible after header alignment settles",
  );
  await page.evaluate("document.querySelector('[data-artifact-content]').scrollTop = 0");
  // Release over the opaque preview, where uncaptured parent pointer listeners
  // would lose both movement and the release event.
  const splitter = await page.evaluate<{ x: number; y: number; width: number }>(
    "(()=>{const node=document.querySelector('[aria-label=\"Resize file panel\"]');const r=node.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+120,width:Number(node.getAttribute('aria-valuenow'))}})()",
  );
  await page.command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: splitter.x,
    y: splitter.y,
  });
  await page.command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    buttons: 1,
    clickCount: 1,
    x: splitter.x,
    y: splitter.y,
  });
  await page.command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    button: "left",
    buttons: 1,
    x: splitter.x + 100,
    y: splitter.y,
  });
  await page.command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    x: splitter.x + 100,
    y: splitter.y,
  });
  await eventually(
    () =>
      page.evaluate(
        `Number(localStorage.getItem('r3-filebrowser-width')) === ${splitter.width + 100} && document.body.style.userSelect !== 'none' && document.body.style.cursor !== 'col-resize'`,
      ),
    "file panel drag persists and releases over a preview iframe",
  );
  const tokens = new Map<string, string>();
  for (const system of ["dark", "light"]) {
    await page.command("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: system }],
    });
    for (const theme of ["dark", "light"]) {
      await page.evaluate(`document.documentElement.classList.toggle('dark', ${theme === "dark"})`);
      const expected =
        theme === "dark"
          ? { foreground: "rgb(245, 245, 245)", background: "rgb(10, 10, 10)" }
          : { foreground: "rgb(23, 23, 23)", background: "rgb(255, 255, 255)" };
      // Wait for the already-bound display channel without reloading the document.
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(
        await colors(),
        expected,
        `Markdown must follow r3 ${theme} even with system ${system}`,
      );
      const token = await markdown.evaluate<string>(
        "getComputedStyle(document.querySelector('pre .sl0') || document.querySelector('pre span[class]')).color",
      );
      assert.notEqual(token, expected.background, "Syntax tokens must remain visible");
      if (tokens.has(theme))
        assert.equal(
          token,
          tokens.get(theme),
          "Syntax follows r3 independently of the system theme",
        );
      tokens.set(theme, token);
    }
  }
  await page.evaluate("document.documentElement.classList.add('dark')");
  await page.evaluate(
    "Array.from(document.querySelectorAll('button')).filter(b=>b.textContent.trim()==='Rendered')[1].click()",
  );
  const html = await eventually(async () => {
    for (const context of page.contexts.values()) {
      if (!context.auxData?.isDefault || context.origin !== "://") continue;
      const frame = page.inContext(context.id);
      try {
        if (await frame.evaluate("document.querySelector('h1')?.textContent === 'Publisher HTML'"))
          return frame;
      } catch {}
    }
    return null;
  }, "publisher HTML");
  assert.equal(
    await html.evaluate("getComputedStyle(document.body).backgroundColor"),
    "rgb(255, 192, 203)",
  );
  await page.evaluate(
    "Array.from(document.querySelector('[data-file=\"index.md\"]').querySelectorAll('button')).find(b=>b.textContent.trim()==='Source').click()",
  );
  await Bun.sleep(100);
  await page.evaluate(
    `document.querySelector('[data-artifact-feedback="${lastSection.id}"] button').click()`,
  );
  const reopened = await eventually(async () => {
    for (const context of page.contexts.values()) {
      if (!context.auxData?.isDefault || context.origin !== "://") continue;
      const frame = page.inContext(context.id);
      try {
        if (
          await frame.evaluate(
            "document.querySelector('h1')?.textContent === 'Published Markdown' && innerHeight > 1000",
          )
        )
          return frame;
      } catch {}
    }
    return null;
  }, "Markdown loads and expands for a rendered Locate from Source");
  await Bun.sleep(300);
  const heading = await reopened.evaluate<{ top: number; bottom: number }>(
    "(()=>{const r=document.querySelector('h2:last-of-type').getBoundingClientRect();return {top:r.top,bottom:r.bottom}})()",
  );
  const visible = await page.evaluate(
    "(()=>{const f=document.querySelector('[data-file=\"index.md\"] iframe').getBoundingClientRect();const p=document.querySelector('[data-artifact-content]').getBoundingClientRect();return {frameTop:f.top,top:p.top,bottom:p.bottom}})()",
  );
  assert.ok(
    heading.top + visible.frameTop >= visible.top &&
      heading.bottom + visible.frameTop <= visible.bottom,
    "Locate from Source keeps the deep rendered target visible after preview sizing",
  );
  assert.equal(storage.artifacts.file(artifact.id, 1, "index.md").renderedHash, retainedHash);
  console.log(
    "Markdown uses its full height, responds to width and image changes, and scrolls the file stack to native targets. It follows all four system/application theme combinations; retained bytes and publisher HTML are preserved.",
  );
} finally {
  await browser?.close();
  app.stop(true);
  preview.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
