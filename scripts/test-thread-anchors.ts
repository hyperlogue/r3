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
    "index.html": `<html><body><h1 id="spot">Same words</h1>${seq === 1 ? '<p id="gone">Original element</p>' : ""}</body></html>`,
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
let pendingResolve: { release: () => void; requested?: boolean } | null = null;
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 60,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/anchor-resolution") && pendingResolve) {
      const held = pendingResolve;
      held.requested = true;
      await new Promise<void>((resolve) => {
        held.release = resolve;
      });
    }
    if (path.startsWith(PREVIEW_PREFIX)) return preview.fetch(request);
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
    "a.txt:3-3",
  );
  await click(source.id);
  await atVersion(3);
  await atLine(4);
  assert.equal(storage.conversations.get(source.id).anchor?.target.versionSeq, 2);
  await click(source.id, "original");
  await atVersion(1);
  await atLine(2);
  await page.evaluate(`${card(source.id)}.querySelector('[data-comment-action=fix]').click()`);
  await atVersion(2);
  await atLine(3);
  await click(missing.id);
  await atVersion(1);
  await atLine(4);
  await eventually(
    () =>
      page.evaluate("document.body.textContent.includes('No unique match in the latest version')"),
    "missing fallback notice",
  );
  await click(ambiguous.id);
  await atVersion(1);
  assert.equal(
    await page.evaluate(
      `${card(ambiguous.id)}.querySelector('[data-thread-action=original]') === null`,
    ),
    true,
  );
  // A slow resolution cannot steal a newer explicit original jump.
  pendingResolve = { release() {} };
  const pending = pendingResolve;
  await click(source.id);
  await eventually(async () => !!pending.requested, "request queued");
  await click(source.id, "original");
  pendingResolve = null;
  pending.release();
  await Bun.sleep(150);
  await atVersion(1);
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
  // A verified rendered locator can follow the latest document, but an absent
  // element must fall back after the runtime's normal hydration window.
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
  await atVersion(3);
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
      "3",
      "a blocked preview must not trigger a saved-location fallback",
    );
    await page.evaluate(
      "[...document.querySelectorAll('[data-preview-compatibility-consent][open] button')].find(button => button.textContent?.includes('Accept risk')).click()",
    );
  }
  await eventually(
    () => page.evaluate("!!document.querySelector('iframe[aria-hidden=false]')"),
    "rendered latest preview",
  );
  await eventually(
    () => page.evaluate("window.anchorLocateEvents.some(event => event.state === 'anchored')"),
    "exact rendered match reported by the verified port",
  );
  assert.equal(
    storage.conversations.get(rendered.id).anchor,
    null,
    "lookup never writes an anchor",
  );
  await click(absentElement.id);
  await atVersion(1);
  await eventually(
    () =>
      page.evaluate("document.body.textContent.includes('No unique match in the latest version')"),
    "rendered missing fallback",
  );
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
  console.log(
    "Thread anchors: latest/original/Fix, exact fallbacks, stale lookup, incremental correction, rendered runtime and phone navigation passed",
  );
} finally {
  pendingResolve?.release();
  await browser?.close();
  app.stop(true);
  api.close();
  preview.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
