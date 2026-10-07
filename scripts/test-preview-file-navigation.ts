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
if (!build.success) throw new Error("File navigation workspace failed to build");
const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
const js = [...assets.keys()].find((name) => name.endsWith(".js"))!;
const css = [...assets.keys()].find((name) => name.endsWith(".css"))!;
const root = await mkdtemp(join(tmpdir(), "r3-file-navigation-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human" as const, sessionId: null };
const artifact = storage.artifacts.create({ kind: "files", actor, title: "File navigation" });
const paragraphs = (count: number) =>
  Array.from({ length: count }, (_, index) => `Paragraph ${index}\n\n`).join("");
await storage.artifacts.publish(artifact.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "navigation",
  content: {
    kind: "files",
    files: [
      {
        path: "a.md",
        mediaType: "text/markdown",
        base64: Buffer.from(
          "# Source document\n\n[Local](#local)\n\n[Destination](b.md#target)\n\n" +
            "[Top](b.md)\n\n" +
            "[Query](b.md?mode=detail#target)\n\n[Missing](missing.md#target)\n\n" +
            "[Source](source.txt)\n\n## Local\n\n" +
            paragraphs(35),
        ).toString("base64"),
      },
      {
        path: "b.md",
        mediaType: "text/markdown",
        base64: Buffer.from(
          `# Destination document\n\n${paragraphs(75)}## Target\n\n${paragraphs(25)}`,
        ).toString("base64"),
      },
      {
        path: "source.txt",
        mediaType: "text/plain",
        base64: Buffer.from("Published source").toString("base64"),
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
let destinationRead = Promise.resolve();
let releaseDestinationRead: (() => void) | undefined;
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.endsWith("/r3/markdown") && url.searchParams.get("path") === "b.md")
      await destinationRead;
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
type Browser = Awaited<ReturnType<typeof openTestBrowser>>;
type Page = Awaited<ReturnType<Browser["attach"]>>;
type DocumentFrame = ReturnType<Page["inContext"]> & { contextId: number };
let browser: Browser | undefined;
try {
  browser = await openTestBrowser();
  for (const width of [1400, 390]) {
    destinationRead = new Promise((resolve) => {
      releaseDestinationRead = resolve;
    });
    const { browserContextId } = await browser.send("Target.createBrowserContext");
    const { targetId } = await browser.send("Target.createTarget", {
      url: "about:blank",
      browserContextId,
    });
    const page: Page = await browser.attach(targetId);
    await page.command("Emulation.setDeviceMetricsOverride", {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: width < 768,
    });
    await page.command("Page.navigate", { url: `http://localhost:${app.port}/` });
    const documentAt = async (path: string, search?: string): Promise<DocumentFrame | null> => {
      for (const context of page.contexts.values()) {
        if (!context.auxData?.isDefault) continue;
        try {
          const frame = page.inContext(context.id);
          if (
            await frame.evaluate(
              `location.pathname.endsWith(${JSON.stringify(`/${path}`)}) && !!document.querySelector('main')${search === undefined ? "" : ` && location.search === ${JSON.stringify(search)}`}`,
            )
          )
            return { ...frame, contextId: context.id };
        } catch {
          /* Native query changes replace the current document. */
        }
      }
      return null;
    };
    const source = await eventually(() => documentAt("a.md"), "source Markdown");
    await eventually(
      () =>
        page.evaluate(
          "document.querySelector('[data-file=\"a.md\"] iframe')?.getAttribute('aria-hidden') === 'false'",
        ),
      "source preview is ready",
    );
    assert.equal(await documentAt("b.md"), null, "the destination document starts unloaded");
    await source.evaluate("document.querySelector('a[href=\"#local\"]').click()");
    await eventually(() => source.evaluate("location.hash === '#local'"), "native local anchor");
    const historyLength = await page.evaluate<number>("history.length");
    const targetVisible = async (search: string) => {
      try {
        const frame = await documentAt("b.md", search);
        if (!frame || !(await frame.evaluate("location.hash === '#target'"))) return false;
        const heading = await frame.evaluate<number>(
          "document.getElementById('target').getBoundingClientRect().top",
        );
        return await page.evaluate(
          `(() => {
          const frame = document.querySelector('[data-file="b.md"] iframe');
          const pane = document.querySelector('[data-artifact-content]');
          if (!frame || frame.getAttribute('aria-hidden') !== 'false') return false;
          const top = frame.getBoundingClientRect().top + ${heading};
          const header = document.querySelector('[data-file="b.md"] [data-file-header]');
          return top >= header.getBoundingClientRect().bottom && top < pane.getBoundingClientRect().bottom - 40;
        })()`,
        );
      } catch {
        return false;
      }
    };
    const follow = async (href: string, search: string) => {
      await source.evaluate(
        `document.querySelector(${JSON.stringify(`a[href="${href}"]`)}).click()`,
      );
      releaseDestinationRead?.();
      await eventually(() => targetVisible(search), `destination heading for ${href}`);
      assert.equal(
        await source.evaluate("document.querySelector('h1').textContent"),
        "Source document",
      );
      assert.equal(await source.evaluate("location.hash"), "#local");
      assert.equal(
        await page.evaluate("history.length"),
        historyLength,
        "handoff only scrolls the stack",
      );
    };
    await follow("b.md#target", "");
    await page.evaluate(
      'document.querySelector(\'[data-file="b.md"] button[title="Collapse"]\').click()',
    );
    await follow("b.md?mode=detail#target", "?mode=detail");
    // A plain fragment link must not inherit the destination's previous query.
    await follow("b.md#target", "");
    await source.evaluate("document.querySelector('a[href=\"b.md\"]').click()");
    await eventually(async () => {
      const frame = await documentAt("b.md", "");
      if (!frame || !(await frame.evaluate("location.hash === ''"))) return false;
      const heading = await frame.evaluate<number>(
        "document.querySelector('h1').getBoundingClientRect().top",
      );
      return page.evaluate(`(() => {
        const frame = document.querySelector('[data-file="b.md"] iframe');
        const pane = document.querySelector('[data-artifact-content]');
        const header = document.querySelector('[data-file="b.md"] [data-file-header]');
        const top = frame.getBoundingClientRect().top + ${heading};
        return Math.abs(frame.getBoundingClientRect().top - pane.getBoundingClientRect().top) < 100 &&
          top >= header.getBoundingClientRect().bottom && top < pane.getBoundingClientRect().bottom - 40;
      })()`);
    }, "a link without a fragment opens the top of the long destination");
    for (const href of ["missing.md#target", "source.txt"]) {
      assert.equal(
        await source.evaluate(`(() => {
          let intercepted;
          window.addEventListener('click', event => {
            intercepted = event.defaultPrevented;
            event.preventDefault();
          }, { once: true });
          document.querySelector(${JSON.stringify(`a[href="${href}"]`)}).click();
          return intercepted;
        })()`),
        false,
        "missing and non-document links retain their existing native behavior",
      );
    }
    await source.evaluate("location.href = 'b.md#target'");
    const restored = await eventually(async () => {
      const frame = await documentAt("a.md");
      return frame?.contextId !== source.contextId ? frame : null;
    }, "source restored after native replacement");
    assert.equal(
      await restored.evaluate("document.querySelector('h1').textContent"),
      "Source document",
    );
    await eventually(() => targetVisible(""), "native replacement hands off its fragment");
    await browser.send("Target.closeTarget", { targetId });
    await browser.send("Target.disposeBrowserContext", { browserContextId });
  }
  console.log(
    "File preview links: desktop/mobile heading handoff, cold/folded targets, query reset, native local anchors, source preservation, and replacement recovery passed.",
  );
} finally {
  releaseDestinationRead?.();
  await browser?.close();
  api.close();
  preview.close();
  await app.stop(true);
  storage.close();
  await rm(root, { recursive: true, force: true });
}
