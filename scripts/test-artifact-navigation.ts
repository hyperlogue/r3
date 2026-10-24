// Navigation regressions against the real SPA, isolated storage, and fresh tabs.
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
  entrypoints: [join(import.meta.dir, "../web/src/main.tsx")],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [await browserLoweredCssPlugin()],
});
if (!build.success) throw new Error(build.logs.map((log) => log.message).join("; "));
const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
const js = build.outputs
  .find((output) => output.path.endsWith(".js"))!
  .path.split("/")
  .at(-1)!;
const css = build.outputs
  .find((output) => output.path.endsWith(".css"))!
  .path.split("/")
  .at(-1)!;
const root = await mkdtemp(join(tmpdir(), "r3-navigation-acceptance-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human", sessionId: null } as const;
const agent = { role: "agent", sessionId: "navigation-agent" } as const;
storage.artifacts.registerSession({ id: agent.sessionId, label: "Navigation agent" });
const artifact = storage.artifacts.create({ kind: "files", actor, title: "Navigation fixture" });
for (const seq of [1, 2])
  await storage.artifacts.publish(artifact.id, {
    actor,
    expectedSeq: seq - 1,
    publicationKey: `navigation-${seq}`,
    content: {
      kind: "files",
      files: [
        {
          path: seq === 1 ? "old.md" : "current.md",
          mediaType: "text/markdown",
          base64: Buffer.from(seq === 1 ? "# Original page" : "# Proposed page").toString("base64"),
        },
        {
          path: "notes.md",
          mediaType: "text/markdown",
          base64: Buffer.from(
            Array.from({ length: 100 }, (_, i) =>
              i === 80 ? "Keyboard focus" : `Note ${i + 1}`,
            ).join("\n"),
          ).toString("base64"),
        },
      ],
    },
  });
const thread = await storage.conversations.add(artifact.id, {
  actor,
  body: "Please improve this heading.",
  target: {
    kind: "rendered",
    versionSeq: 1,
    path: "old.md",
    locator: { selector: "h1", quote: "Original page" },
  },
});
const fix = await storage.conversations.addComment(thread.id, {
  actor: agent,
  body: "Needle: the proposed heading is ready.",
  target: {
    kind: "rendered",
    versionSeq: 2,
    path: "current.md",
    locator: { selector: "h1", quote: "Proposed page" },
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
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith(PREVIEW_PREFIX)) return preview.fetch(request);
    if (path.startsWith("/api/")) return api.app.fetch(request);
    const asset = assets.get(path.slice(1));
    if (asset) return new Response(asset);
    return new Response(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/${css}"></head><body><div id="root"></div><script type="module" src="/${js}"></script></body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
let browser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
try {
  browser = await openTestBrowser();
  const errors: string[] = [];
  browser.listen((event) => {
    if (event.method === "Runtime.exceptionThrown")
      errors.push(
        event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text,
      );
  });
  const origin = `http://localhost:${server.port}`;
  const createPage = async (blocked = false) => {
    const { targetId } = await browser!.send("Target.createTarget", { url: "about:blank" });
    const page = await browser!.attach(targetId);
    await page.command("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.command("Page.addScriptToEvaluateOnNewDocument", {
      source: `if (window.top === window) { localStorage.setItem("r3:preview-compatibility:v1", "accepted");${blocked ? 'Object.defineProperty(window, "sessionStorage", {get(){throw new Error("Storage blocked for test");}});' : ""} }`,
    });
    return page;
  };
  const page = await createPage();
  const wait = (script: string, description: string) =>
    eventually(() => page.evaluate(script), description);
  const click = (selector: string) =>
    page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const url = `${origin}/${artifact.id}?version=2`;
  await page.command("Page.navigate", {
    url: `${url}&file=old.md&view=source&thread=${thread.id}&discussions=old&summary=1&text=old&line=1&side=old&comment=old&compare=missing&library=%3Fq%3Dneedle&lang=en`,
  });
  await wait("!!document.querySelector('[data-file=\"current.md\"]')", "requested publication");
  await wait(
    "new URLSearchParams(location.search).size === 3",
    "retired parameters and invalid comparison removed",
  );
  assert.equal(await page.evaluate("document.querySelector('[data-version-count]').value"), "2");
  assert.equal(await page.evaluate("!!document.querySelector('[data-thread-focused]')"), false);

  await click('[data-file="notes.md"] button[title="Source"]');
  await click(`[data-artifact-thread="${thread.id}"]`);
  await wait(
    `!!document.querySelector('[data-artifact-thread="${thread.id}"][data-thread-focused]')`,
    "thread focus",
  );
  await page.command("Page.reload");
  await wait(
    "document.querySelector('[data-file=\"notes.md\"] button[title=Source]')?.getAttribute('aria-pressed') === 'true'",
    "saved representation restored",
  );
  assert.equal(
    await page.evaluate("document.querySelector('[data-version-count]').value"),
    "2",
    "reload must not follow the older thread target",
  );
  assert.equal(
    await page.evaluate(
      `!!document.querySelector('[data-artifact-thread="${thread.id}"][data-thread-focused]')`,
    ),
    true,
  );

  const other = await createPage();
  await other.command("Page.navigate", { url });
  await eventually(
    () =>
      other.evaluate(
        "document.querySelector('[data-file=\"notes.md\"] button[title=Rendered]')?.getAttribute('aria-pressed') === 'true'",
      ),
    "independent tab defaults",
  );
  assert.equal(await other.evaluate("!!document.querySelector('[data-thread-focused]')"), false);

  await click(`[data-compare-comment="${fix.id}"]`);
  await wait("document.querySelector('[data-artifact-surface]').inert", "comparison opened");
  await page.evaluate("history.back()");
  await wait("!document.querySelector('[data-artifact-surface]').inert", "Back closes comparison");
  await page.evaluate("history.forward()");
  await wait(
    "document.querySelector('[data-artifact-surface]').inert",
    "Forward restores comparison",
  );
  await page.command("Page.reload");
  await wait("document.querySelector('[data-artifact-surface]')?.inert", "comparison reload");
  await click("[data-version-count]");
  await click('[data-version-seq="1"]');
  await wait(
    "document.querySelector('[data-version-count]').value === '1' && !document.querySelector('[data-artifact-surface]').inert",
    "version switch exits comparison",
  );
  assert.equal(await page.evaluate("location.search"), "?version=1&library=%3Fq%3Dneedle&lang=en");
  assert.equal(await page.evaluate("!!document.querySelector('[data-thread-focused]')"), false);
  await page.command("Page.reload");
  await wait(
    "document.querySelector('[data-version-count]')?.value === '1'",
    "new version survives reload",
  );
  await wait(
    "!!document.querySelector('[data-file=\"notes.md\"] button[title=Rendered]')",
    "new publication membership loaded",
  );
  assert.equal(
    await page.evaluate(
      "document.querySelector('[data-file=\"notes.md\"] button[title=Rendered]').getAttribute('aria-pressed')",
    ),
    "true",
  );

  // Search navigation carries its one-time intent outside the address bar.
  await page.command("Page.navigate", { url: `${origin}/?q=needle&history=all` });
  await wait(
    `!!document.querySelector('[data-search-match="${fix.id}"]')`,
    "comment search result",
  );
  await click(`[data-search-match="${fix.id}"]`);
  await wait(
    `!!document.querySelector('[data-artifact-thread="${thread.id}"][data-thread-focused]')`,
    "search focuses its conversation",
  );
  assert.equal(await page.evaluate("document.querySelector('[data-version-count]').value"), "2");
  assert.deepEqual(await page.evaluate("[...new URLSearchParams(location.search).keys()]"), [
    "version",
    "library",
  ]);
  assert.equal(
    await page.evaluate("!!history.state.r3SearchMatch"),
    false,
    "search intent is consumed",
  );
  await page.command("Page.reload");
  await wait(
    "document.querySelector('[data-version-count]')?.value === '2'",
    "search reload keeps comment publication",
  );
  await page.evaluate("history.back()");
  await wait(
    "!!document.querySelector('[data-search-category=comment]')",
    "Back restores library search",
  );
  await page.evaluate("history.forward()");
  await wait(
    "document.querySelector('[data-version-count]')?.value === '2'",
    "Forward restores the publication",
  );

  await page.command("Page.navigate", { url: `${origin}/?q=keyboard&history=all` });
  await wait(
    "!!document.querySelector('[data-search-category=content][href*=\"version=1\"]')",
    "historical content search",
  );
  await click('[data-search-category=content][href*="version=1"]');
  await wait(
    '!!document.querySelector(\'[data-file="notes.md"] [data-line="81"]\')',
    "source search target mounted",
  );
  assert.equal(await page.evaluate("document.querySelector('[data-version-count]').value"), "1");
  assert.deepEqual(await page.evaluate("[...new URLSearchParams(location.search).keys()]"), [
    "version",
    "library",
  ]);

  const blocked = await createPage(true);
  await blocked.command("Page.navigate", { url });
  await eventually(
    () =>
      blocked.evaluate("!!document.querySelector('[data-file=\"notes.md\"] button[title=Source]')"),
    "workspace with unavailable storage",
  );
  await blocked.evaluate(
    "document.querySelector('[data-file=\"notes.md\"] button[title=Source]').click()",
  );
  await eventually(
    () =>
      blocked.evaluate(
        "document.querySelector('[data-file=\"notes.md\"] button[title=Source]').getAttribute('aria-pressed') === 'true'",
      ),
    "selection works without storage",
  );
  assert.deepEqual(errors, []);
  console.log(
    "Navigation browser acceptance passed: clean URLs, version authority, tab-local reloads, independent tabs, comparison Back/Forward/reload/reset, search context, and unavailable storage.",
  );
} finally {
  await browser?.close();
  api.close();
  preview.close();
  await server.stop(true);
  storage.close();
  await rm(root, { recursive: true, force: true });
}
