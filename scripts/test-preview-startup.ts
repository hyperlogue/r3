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
const root = await mkdtemp(join(tmpdir(), "r3-startup-acceptance-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human" as const, sessionId: null };
const artifact = storage.artifacts.create({ kind: "html", actor, title: "Published workspace" });
// Keep a native utility import so readiness also proves the inline runtime ran
// before publisher modules; no unrelated publications or discussions are needed.
const source =
  '<!doctype html><html><head><title>Startup fixture</title></head><body><h1>Published document</h1><script type="module">import r3 from "/r3/utility.js";window.r3=r3;</script></body></html>';
await storage.artifacts.publish(artifact.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "startup",
  content: {
    kind: "html",
    files: [
      {
        path: "index.html",
        mediaType: "text/html",
        base64: Buffer.from(source).toString("base64"),
      },
    ],
  },
});
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
const requests: { path: string; at: number }[] = [];
let started = 0;
let manifestReturned = 0;
let checkReturned = 0;
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    requests.push({ path, at: performance.now() - started });
    // Model a remote round trip without touching a real daemon or network.
    if (path.startsWith("/api/") || path.startsWith(PREVIEW_PREFIX)) await Bun.sleep(90);
    if (path.startsWith(PREVIEW_PREFIX)) {
      const response = await preview.fetch(request);
      if (path.endsWith("/r3/check")) checkReturned = performance.now() - started;
      return response;
    }
    if (path.startsWith("/api/")) {
      if (path.endsWith("/files") && process.env.R3_TEST_SLOW_MANIFEST === "1")
        await Bun.sleep(600);
      const response = await api.app.fetch(request);
      if (path.endsWith("/files")) manifestReturned = performance.now() - started;
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
  started = performance.now();
  await page.command("Page.navigate", {
    url: `http://localhost:${app.port}/${artifact.id}?version=1&file=index.html&view=rendered`,
  });
  await eventually(
    () => page.evaluate(`!!document.querySelector('iframe[aria-hidden="false"]')`),
    "visible published preview",
  );
  const elapsed = Math.round(performance.now() - started);
  const at = (suffix: string) => requests.find((request) => request.path.endsWith(suffix))?.at;
  console.log(
    JSON.stringify({
      readyMs: elapsed,
      manifestMs: Math.round(at("/files") ?? -1),
      previewMs: Math.round(at("/previews") ?? -1),
      gateMs: Math.round(at("/r3/gate") ?? -1),
      checkMs: Math.round(at("/r3/check") ?? -1),
      documentMs: Math.round(at("/files/index.html") ?? -1),
      manifestReturnedMs: Math.round(manifestReturned),
      runtimeRequests: requests.filter((request) => request.path.endsWith("/r3/runtime.js")).length,
    }),
  );
  assert.ok(
    at("/previews")! < manifestReturned,
    "preview setup must overlap the entrypoint manifest request",
  );
  assert.ok(
    at("/files/index.html")! >= manifestReturned,
    "published content must wait for manifest membership",
  );
  assert.ok(checkReturned > 0, "every opening must verify the browser");
  assert.ok(at("/r3/utility.js") !== undefined, "publisher modules must execute");
  assert.ok(
    at("/files/index.html")! >= checkReturned,
    "published HTML must wait for the successful gate",
  );
  assert.equal(
    requests.filter((request) => request.path.endsWith("/r3/runtime.js")).length,
    0,
    "opening must not wait for a separate parser-blocking runtime request",
  );
} finally {
  await browser?.close();
  app.stop(true);
  api.close();
  preview.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
