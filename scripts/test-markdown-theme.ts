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
          "# Published Markdown\n\nReadable body text.\n\n```ts\nconst value = 42;\n```",
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
const preview = new PreviewHost(storage.artifacts, undefined, previewSupport);
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
  assert.equal(storage.artifacts.file(artifact.id, 1, "index.md").renderedHash, retainedHash);
  console.log(
    "Markdown follows r3 in all four system/application theme combinations; retained bytes and publisher HTML are preserved.",
  );
} finally {
  await browser?.close();
  app.stop(true);
  preview.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
