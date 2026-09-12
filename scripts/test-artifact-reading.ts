import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactApi } from "../server/artifact-api.ts";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import { eventually, openTestBrowser } from "./browser.ts";
import { browserLoweredCssPlugin } from "./spa-css.ts";

// Exercise computed browser styles and reading interactions against real
// publication/source/diff endpoints, with no normal daemon or user profile.
const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "preview-workspace-fixture.tsx")],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [await browserLoweredCssPlugin()],
});
if (!build.success) throw new Error("Reading acceptance workspace failed to build");
const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
const script = build.outputs
  .find((output) => output.path.endsWith(".js"))!
  .path.split("/")
  .at(-1)!;
const css = build.outputs
  .find((output) => output.path.endsWith(".css"))!
  .path.split("/")
  .at(-1)!;
const root = await mkdtemp(join(tmpdir(), "r3-reading-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human" as const, sessionId: null };
const source = 'export const greeting: string = "Hello";\n';
const files = storage.artifacts.create({ kind: "files", actor, title: "Published source" });
await storage.artifacts.publish(files.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "source",
  content: {
    kind: "files",
    files: [
      {
        path: "source.ts",
        mediaType: "text/plain",
        base64: Buffer.from(source).toString("base64"),
      },
    ],
  },
});
const diff = storage.artifacts.create({ kind: "diff", actor, title: "Published diff" });
await storage.artifacts.publish(diff.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "diff",
  content: {
    kind: "diff",
    patch: `diff --git a/source.ts b/source.ts\n--- a/source.ts\n+++ b/source.ts\n@@ -1 +1 @@\n-export const greeting: string = "Before";\n+${source}`,
  },
});
const api = createArtifactApi(storage, {
  token: randomBytes(32).toString("base64url"),
  requireLogin: false,
  version: "acceptance",
  allowedHost: (host) => host === "localhost",
});
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) return api.app.fetch(request);
    const asset = assets.get(path.slice(1));
    if (asset) return new Response(asset);
    return new Response(
      `<!doctype html><html><head><link rel="stylesheet" href="/${css}"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style></head><body><div id="root"></div><script type="module" src="/${script}"></script></body></html>`,
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
  for (const artifact of [files, diff]) {
    await page.command("Page.navigate", {
      url: `http://localhost:${app.port}/?artifact=${artifact.id}&version=1`,
    });
    await eventually(
      () => page.evaluate("!!document.querySelector('.shiki-code span')"),
      "published tokens",
    );
    await eventually(
      () => page.evaluate("!!document.querySelector('style[data-r3-theme-css]')?.textContent"),
      "syntax palette",
    );
    for (const dark of [false, true]) {
      await page.evaluate(`document.documentElement.classList.toggle('dark', ${dark})`);
      const colors = await page.evaluate<string[]>(
        "[...new Set([...document.querySelectorAll('.shiki-code span')].map(node => getComputedStyle(node).color))]",
      );
      assert(
        colors.length > 1,
        `${artifact.kind} ${dark ? "dark" : "light"}: published tokens must have distinct syntax colors; got ${colors.join(", ")}`,
      );
    }
  }
  console.log("Published source and diff syntax colors passed in light and dark modes");
} finally {
  await browser?.close();
  app.stop(true);
  api.close();
  await storage.close();
  await rm(root, { recursive: true, force: true });
}
