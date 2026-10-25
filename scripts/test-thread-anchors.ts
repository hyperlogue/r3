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
if (!build.success) throw new Error(`Anchor workspace build failed: ${build.logs.join("\n")}`);
const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
const js = build.outputs
  .find((file) => file.path.endsWith(".js"))!
  .path.split("/")
  .at(-1)!;
const css = build.outputs
  .find((file) => file.path.endsWith(".css"))!
  .path.split("/")
  .at(-1)!;
const root = await mkdtemp(join(tmpdir(), "r3-anchor-browser-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human", sessionId: null } as const;
const artifact = storage.artifacts.create({
  kind: "files",
  actor,
  title: "Thread anchor acceptance",
});
async function publish(seq: number) {
  const members = {
    "a.txt":
      seq === 1
        ? "header\nneedle\nbefore\ngone\n"
        : seq === 2
          ? "header\ninsert\nneedle\nbefore\n"
          : "header\ninsert\nextra\nneedle\nbefore\n",
    "b.txt": seq < 3 ? "duplicate\n" : "duplicate\nduplicate\n",
    "index.html": `<html><body><h1 id="spot">Same words</h1>${seq === 1 ? '<p id="gone">Original element</p>' : ""}<p id="long" style="width:180px">${"Long paragraph text. ".repeat(220)}Exact quote near the end.</p></body></html>`,
  };
  await storage.artifacts.publish(artifact.id, {
    actor,
    expectedSeq: seq - 1,
    publicationKey: `v${seq}`,
    content: {
      kind: "files",
      files: Object.entries(members).map(([path, text]) => ({
        path,
        mediaType: path.endsWith("html") ? "text/html" : "text/plain",
        base64: Buffer.from(text).toString("base64"),
      })),
    },
  });
}
await publish(1);
const source = await storage.conversations.add(artifact.id, {
  actor,
  body: "Original quote stays fixed",
  target: {
    kind: "source",
    versionSeq: 1,
    path: "a.txt",
    locator: { start: 2, end: 2, quote: "needle" },
  },
});
const missing = await storage.conversations.add(artifact.id, {
  actor,
  body: "Deleted source",
  target: {
    kind: "source",
    versionSeq: 1,
    path: "a.txt",
    locator: { start: 4, end: 4, quote: "gone" },
  },
});
const ambiguous = await storage.conversations.add(artifact.id, {
  actor,
  body: "Ambiguous source",
  target: {
    kind: "source",
    versionSeq: 1,
    path: "b.txt",
    locator: { start: 1, end: 1, quote: "duplicate" },
  },
});
const rendered = await storage.conversations.add(artifact.id, {
  actor,
  body: "Stable rendered location",
  target: {
    kind: "rendered",
    versionSeq: 1,
    path: "index.html",
    locator: { selector: "#spot", quote: "Same words" },
  },
});
const absentElement = await storage.conversations.add(artifact.id, {
  actor,
  body: "Missing rendered location",
  target: {
    kind: "rendered",
    versionSeq: 1,
    path: "index.html",
    locator: { selector: "#gone", quote: "Original element" },
  },
});
const wholePage = await storage.conversations.add(artifact.id, {
  actor,
  body: "Whole page anchor",
  target: {
    kind: "rendered",
    versionSeq: 1,
    path: "index.html",
    locator: null,
  },
});
const element = await storage.conversations.add(artifact.id, {
  actor,
  body: "Element anchor",
  target: {
    kind: "rendered",
    versionSeq: 1,
    path: "index.html",
    locator: { selector: "#spot" },
  },
});
const longQuote = await storage.conversations.add(artifact.id, {
  actor,
  body: "Quote in a tall paragraph",
  target: {
    kind: "rendered",
    versionSeq: 1,
    path: "index.html",
    locator: { selector: "#long", quote: "Exact quote near the end." },
  },
});
await publish(2);
await storage.conversations.anchors.reanchor(artifact.id, {
  actor,
  expectedSeq: 2,
  operationKey: "move",
  items: [
    {
      threadId: source.id,
      expectedAnchorRevision: 0,
      target: { kind: "source", versionSeq: 2, path: "a.txt", locator: { start: 3, end: 3 } },
    },
  ],
});
await storage.conversations.addComment(source.id, {
  actor,
  body: "Pinned fix",
  target: {
    kind: "source",
    versionSeq: 2,
    path: "a.txt",
    locator: { start: 3, end: 3, quote: "needle" },
  },
});
await publish(3);
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
let resolutionRequests = 0;
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 60,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/anchor-resolution")) {
      resolutionRequests++;
      return Response.json(
        { error: "Navigation must use the recorded destination" },
        { status: 500 },
      );
    }
    if (path.startsWith(PREVIEW_PREFIX)) return preview.fetch(request);
    if (path.startsWith("/api/")) return api.app.fetch(request);
    const asset = assets.get(path.slice(1));
    if (asset) return new Response(asset);
    return new Response(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/${css}"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style></head><body><div id="root"></div><script type="module" src="/${js}"></script></body></html>`,
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
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.command("Page.navigate", {
    url: `http://localhost:${app.port}/${artifact.id}?version=1`,
  });
  const card = (id: string) =>
    `document.querySelector('[data-artifact-thread="${id}"]:not([inert]):not([inert] *)')`;
  await eventually(
    () => page.evaluate(`!!${card(source.id)}?.querySelector('[data-thread-action=locate]')`),
    "thread card",
  );
  const click = (id: string, action = "locate") =>
    page.evaluate(`${card(id)}.querySelector('[data-thread-action=${action}]').click()`);
  const atVersion = (seq: number) =>
    eventually(
      () => page.evaluate(`new URLSearchParams(location.search).get('version') === '${seq}'`),
      `version ${seq}`,
    );
  const atLine = (line: number) =>
    eventually(
      () =>
        page.evaluate(
          `!!document.querySelector('[data-file="a.txt"] [data-line="${line}"].r3-active-line')`,
        ),
      `line ${line}`,
    );
  assert.equal(
    await page.evaluate(
      `${card(source.id)}.querySelector('[data-thread-action=locate]').textContent.trim()`,
    ),
    "a.txt:3-3 · v2",
  );
  await click(source.id);
  await atVersion(2);
  await atLine(3);
  assert.equal(storage.conversations.get(source.id).anchor?.target.versionSeq, 2);
  await Bun.sleep(2200);
  assert.equal(
    await page.evaluate("!!document.querySelector('.r3-active-line')"),
    false,
    "source navigation feedback expires without changing the destination",
  );
  await click(source.id);
  await atLine(3);
  await click(source.id, "original");
  await atVersion(1);
  await atLine(2);
  await page.evaluate(`${card(source.id)}.querySelector('[data-comment-action=fix]').click()`);
  await atVersion(2);
  await atLine(3);
  await click(missing.id);
  await atVersion(1);
  await atLine(4);
  await click(ambiguous.id);
  await atVersion(1);
  assert.equal(
    await page.evaluate(
      `${card(ambiguous.id)}.querySelector('[data-thread-action=original]') === null`,
    ),
    true,
  );
  // Rapid explicit navigation never waits for a lookup or steals a newer jump.
  await click(source.id);
  await click(source.id, "original");
  await atVersion(1);
  await atLine(2);
  assert.equal(resolutionRequests, 0);
  // Same-version corrections arrive through the ordinary incremental thread update.
  await storage.conversations.anchors.reanchor(artifact.id, {
    actor,
    expectedSeq: 3,
    operationKey: "correct",
    items: [
      {
        threadId: source.id,
        expectedAnchorRevision: 1,
        target: { kind: "source", versionSeq: 3, path: "a.txt", locator: { start: 5, end: 5 } },
      },
    ],
  });
  api.collaboration.broadcast({
    type: "threads-updated",
    artifactId: artifact.id,
    threadId: source.id,
  });
  await eventually(
    () =>
      page.evaluate(
        `${card(source.id)}.querySelector('[data-thread-action=locate]').textContent.includes('5-5')`,
      ),
    "incremental anchor update",
  );
  await click(source.id);
  await atVersion(3);
  await atLine(5);
  assert.ok(
    await page.evaluate(`${card(source.id)}.textContent.includes('needle')`),
    "original quote stays visible",
  );
  // Rendered anchors open their recorded publication immediately, even if the
  // element has disappeared from later publications.
  await page.evaluate(`(() => {
    window.anchorLocateEvents = [];
    const descriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, 'onmessage');
    Object.defineProperty(MessagePort.prototype, 'onmessage', { ...descriptor, set(callback) {
      descriptor.set.call(this, callback && ((event) => {
        if (event.data?.type === 'r3-preview-located') window.anchorLocateEvents.push({ state:event.data.state, nonce:event.data.nonce });
        callback.call(this, event);
      }));
    }});
  })()`);
  await click(rendered.id);
  await atVersion(1);
  const admission = await eventually(
    () =>
      page.evaluate(
        `document.querySelector('iframe[aria-hidden="false"]') ? 'ready' : document.querySelector('[data-preview-compatibility-consent][open]') ? 'consent' : null`,
      ),
    "preview admission",
  );
  if (admission === "consent") {
    // The fixture is controlled content in a fresh profile. Exercise actual
    // browser-risk consent rather than bypassing the production preview gate.
    assert.equal(
      await page.evaluate("new URLSearchParams(location.search).get('version')"),
      "1",
      "preview admission must preserve the requested publication",
    );
    await page.evaluate(
      "[...document.querySelectorAll('[data-preview-compatibility-consent][open] button')].find(button => button.textContent?.includes('Accept risk')).click()",
    );
  }
  await eventually(
    () => page.evaluate("!!document.querySelector('iframe[aria-hidden=false]')"),
    "recorded rendered preview",
  );
  await eventually(
    () => page.evaluate("window.anchorLocateEvents.some(event => event.state === 'anchored')"),
    "exact rendered match reported by the verified port",
  );
  const content = await eventually(async () => {
    for (const context of page.contexts.values()) {
      if (!context.auxData?.isDefault) continue;
      const frame = page.inContext(context.id);
      try {
        if (await frame.evaluate("!!document.querySelector('#spot')")) return frame;
      } catch {}
    }
    return null;
  }, "published frame");
  const ui = async (selector: string, expression: string) => {
    const { root } = await page.command("DOM.getDocument", { depth: -1, pierce: true });
    const find = (node: any): any =>
      node.attributes?.includes("data-r3-preview")
        ? node
        : [...(node.children ?? []), ...(node.contentDocument ? [node.contentDocument] : [])]
            .map(find)
            .find(Boolean);
    const shadow = find(root)?.shadowRoots?.[0];
    assert(shadow, "trusted feedback overlay");
    const resolved = await page.command("DOM.resolveNode", { nodeId: shadow.nodeId });
    const result = await page.command("Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration: `function(){const el=this.querySelector(${JSON.stringify(selector)});return ${expression}}`,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const highlight = () => content.evaluate("CSS.highlights.has('r3-preview-active')");
  const feedback = async (id: string, state = "anchored") => {
    await page.evaluate("window.anchorLocateEvents = []");
    const start = performance.now();
    await click(id);
    await eventually(
      () =>
        page.evaluate(`window.anchorLocateEvents.some(e => e.state === ${JSON.stringify(state)})`),
      "immediate Locate result",
    );
    const elapsed = performance.now() - start;
    assert.ok(
      elapsed < 600,
      `warm Locate should respond without a retry delay (${Math.round(elapsed)} ms)`,
    );
    return Math.round(elapsed);
  };
  const timings: Record<string, number> = {};
  timings.exact = await feedback(rendered.id);
  await eventually(highlight, "exact quote highlighted");
  assert.equal(
    await ui(".location", "el.hidden"),
    true,
    "text targets do not outline their container",
  );
  assert.equal(
    await ui(".box", "el.hidden"),
    true,
    "navigation does not activate the comment picker",
  );
  await Bun.sleep(2200);
  assert.equal(await highlight(), false, "quote feedback expires");
  api.collaboration.broadcast({
    type: "threads-updated",
    artifactId: artifact.id,
    threadId: rendered.id,
  });
  await Bun.sleep(150);
  assert.equal(await highlight(), false, "refetch must not revive dismissed feedback");
  await feedback(rendered.id);
  await eventually(highlight, "repeat Locate shows feedback again");
  await content.evaluate(
    "document.body.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true}))",
  );
  await eventually(async () => !(await highlight()), "click-away clears feedback in the frame");
  await feedback(rendered.id);
  await eventually(highlight, "fresh feedback before workspace dismissal");
  await page.command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await page.command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "Escape",
    code: "Escape",
    windowsVirtualKeyCode: 27,
  });
  await eventually(async () => !(await highlight()), "workspace Escape clears preview feedback");
  await page.evaluate(
    "[...document.querySelectorAll('button')].find(b=>/discussion/i.test((b.getAttribute('aria-label')||'')+' '+(b.getAttribute('title')||'')))?.click()",
  );
  await eventually(() => page.evaluate(`!!${card(rendered.id)}`), "discussion reopened");
  await feedback(wholePage.id);
  assert.equal(await ui(".location-label", "!el.hidden && el.textContent === 'Whole page'"), true);
  assert.equal(
    await ui(".location", "el.hidden"),
    true,
    "whole-page navigation never boxes the viewport",
  );
  await Bun.sleep(2200);
  assert.equal(await ui(".location-label", "el.hidden"), true, "whole-page label expires too");
  await feedback(element.id);
  await eventually(async () => !(await ui(".location", "el.hidden")), "element outline");
  assert.equal(await ui(".location", "getComputedStyle(el).backgroundColor"), "rgba(0, 0, 0, 0)");
  if (process.env.R3_TEST_SCREENSHOTS) {
    const { data } = await page.command("Page.captureScreenshot", { format: "png" });
    await Bun.write(
      join(process.env.R3_TEST_SCREENSHOTS, "anchor-element.png"),
      Buffer.from(data, "base64"),
    );
  }
  await content.evaluate("document.querySelector('#spot').textContent='Changed words'");
  timings.context = await feedback(rendered.id, "ancestor");
  assert.equal(await highlight(), false, "changed text is context, not a false exact quote");
  await atVersion(1);
  await content.evaluate("document.querySelector('#spot').textContent='Same words'");
  await eventually(
    () => page.evaluate("window.anchorLocateEvents.some(e=>e.state==='anchored')"),
    "hydration promotes context to an exact match",
  );
  await content.evaluate("document.querySelector('#spot').textContent='Changed again'");
  await feedback(rendered.id, "ancestor");
  await content.evaluate(
    "document.body.dispatchEvent(new WheelEvent('wheel', {bubbles:true}));document.querySelector('#spot').textContent='Same words'",
  );
  await Bun.sleep(200);
  assert.equal(
    await page.evaluate("window.anchorLocateEvents.some(e=>e.state==='anchored')"),
    false,
    "interaction cancels late hydration instead of stealing the reader's position",
  );
  assert.equal(await ui(".location", "el.hidden"), true);
  await content.evaluate("document.querySelector('#gone').remove()");
  timings.unavailable = await feedback(absentElement.id, "unplaced");
  await atVersion(1);
  assert.equal(await ui(".location", "el.hidden"), true, "missing targets do not invent an area");
  timings.longQuote = await feedback(longQuote.id);
  await eventually(highlight, "quote in tall paragraph highlighted");
  assert.equal(
    await content.evaluate(`(() => {
    const rect = [...CSS.highlights.get('r3-preview-active')][0].getBoundingClientRect();
    return rect.top >= 0 && rect.bottom <= innerHeight;
  })()`),
    true,
    "Locate scrolls to the quoted text, not the middle of its tall paragraph",
  );
  console.log("Warm anchor response (ms):", JSON.stringify(timings));
  assert.equal(
    storage.conversations.get(rendered.id).anchor,
    null,
    "lookup never writes an anchor",
  );
  await click(absentElement.id);
  await atVersion(1);
  assert.equal(resolutionRequests, 0, "anchor navigation needs no speculative resolution request");
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await page.evaluate(
    "[...document.querySelectorAll('button')].find(button => button.textContent?.includes('Discussion') && button.getBoundingClientRect().width > 0)?.click()",
  );
  await eventually(
    () => page.evaluate(`!!${card(source.id)}?.querySelector('[data-thread-action=locate]')`),
    "mobile thread",
  );
  await click(source.id);
  await atVersion(3);
  await atLine(5);
  await page.evaluate(
    "[...document.querySelectorAll('button')].find(button => button.textContent?.includes('Discussion') && button.getBoundingClientRect().width > 0)?.click()",
  );
  await eventually(() => page.evaluate(`!!${card(wholePage.id)}`), "mobile discussion reopened");
  await click(wholePage.id);
  await atVersion(1);
  await eventually(async () => {
    try {
      return await ui(".location-label", "!el.hidden");
    } catch {
      return false;
    }
  }, "whole-page feedback on a phone");
  assert.equal(await ui(".location", "el.hidden"), true);
  if (process.env.R3_TEST_SCREENSHOTS) {
    const { data } = await page.command("Page.captureScreenshot", { format: "png" });
    await Bun.write(
      join(process.env.R3_TEST_SCREENSHOTS, "anchor-phone.png"),
      Buffer.from(data, "base64"),
    );
  }
  console.log(
    "Thread anchors: recorded/current/original/Fix, lookup-free navigation, incremental correction, rendered runtime and phone navigation passed",
  );
} finally {
  await browser?.close();
  app.stop(true);
  api.close();
  preview.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
