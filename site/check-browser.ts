import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { eventually, openTestBrowser } from "../scripts/browser.ts";
import { commonPrompt, commonResponse, promptExamples } from "./prompt-examples.ts";
import { normalizeBase } from "./render.ts";
import { serveSite } from "./serve.ts";

// Uses a fresh browser profile and a loopback-only static server. Supply the
// browser executable through R3_TEST_BROWSER; no normal r3 server is involved.
const base = normalizeBase(process.env.R3_SITE_BASE);
const server = serveSite(join(import.meta.dir, "../dist/pages"), { base, port: 0 });
const browser = await openTestBrowser();
const exceptions: string[] = [];
const outside = new Set<string>();
const images = join(import.meta.dir, "../dist/site-review");
await mkdir(images, { recursive: true });
browser.listen((event) => {
  if (event.method === "Runtime.exceptionThrown")
    exceptions.push(event.params.exceptionDetails.text);
  if (event.method === "Network.requestWillBeSent") {
    const url = new URL(event.params.request.url);
    if (/^https?:$/.test(url.protocol) && url.origin !== server.url.origin) outside.add(url.origin);
  }
});
try {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  await page.command("Network.enable");
  const viewport = (width: number, height = 960) =>
    page.command("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  const open = async (path: string, heading: string) => {
    await page.command("Page.navigate", { url: `${server.url.origin}${base}${path}` });
    await eventually(
      () =>
        page.evaluate(
          `document.readyState==='complete' && document.querySelector('h1')?.textContent.includes(${JSON.stringify(heading)})`,
        ),
      `page ${path}`,
    );
  };
  const screenshot = async (name: string) => {
    await page.evaluate(
      "Promise.all(document.getAnimations().map(animation => animation.finished))",
    );
    const { data } = await page.command("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(images, name), Buffer.from(data, "base64"));
  };
  const noOverflow = async () =>
    assert(
      await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
      "page must fit viewport",
    );

  await viewport(1440);
  await open("/", "Give your agent a place to show its work.");
  await noOverflow();
  await screenshot("home-desktop.png");
  await browser.send("Browser.grantPermissions", {
    origin: server.url.origin,
    permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"],
  });
  await page.evaluate("document.querySelector('#skill-install .copy-code').click()");
  await eventually(
    () => page.evaluate("document.querySelector('.toast').textContent==='Install command copied'"),
    "install command copy",
  );
  assert.equal(
    await page.evaluate("navigator.clipboard.readText()"),
    "npx skills add hyperlogue/r3 --skill publish-artifacts-to-r3 --global",
  );
  assert(
    await page.evaluate(
      "getComputedStyle(document.querySelector('#skill-install .copy-check')).display !== 'none' && getComputedStyle(document.querySelector('#skill-install .copy-icon')).display === 'none'",
    ),
    "successful copy shows the check icon",
  );
  await eventually(
    () =>
      page.evaluate(
        "document.querySelector('#skill-install .copy-code').getAttribute('aria-label') === 'Copy install command' && getComputedStyle(document.querySelector('#skill-install .copy-icon')).display !== 'none'",
      ),
    "copy icon resets after the confirmation",
  );
  const theme = await page.evaluate("document.documentElement.dataset.theme");
  await page.evaluate("document.querySelector('.theme-toggle').click()");
  assert.notEqual(await page.evaluate("document.documentElement.dataset.theme"), theme);
  await screenshot("home-dark.png");
  await page.evaluate(
    "document.querySelector('#agent-prompt').scrollIntoView({behavior:'instant',block:'center'})",
  );
  await page.evaluate(
    "document.querySelector('[data-prompt-choice=\"0\"]').click(); document.querySelector('[data-prompt-play]').click()",
  );
  for (const index of [0, 1, 2]) {
    await eventually(
      () =>
        page.evaluate(
          `document.querySelector('[data-prompt-demo]').dataset.example === '${index}' && document.querySelector('[data-prompt-demo]').dataset.phase === 'ready'`,
        ),
      `animated prompt ${index}`,
    );
    assert.equal(
      await page.evaluate("document.querySelector('[data-prompt-text]').textContent"),
      promptExamples[index]!.prompt,
    );
    assert.deepEqual(
      await page.evaluate(
        "[...document.querySelectorAll('[data-prompt-common]')].map(el => el.textContent)",
      ),
      [commonPrompt, commonResponse],
      "shared prompt and response remain unchanged",
    );
    if (index < 2) {
      await eventually(
        () =>
          page.evaluate("document.querySelector('[data-prompt-demo]').dataset.phase === 'leaving'"),
        "example fades out",
      );
      assert(
        await page.evaluate(
          "[...document.querySelectorAll('[data-prompt-common], .prompt-scene')].every(el => getComputedStyle(el).opacity === '1')",
        ),
        "common lines and their container do not fade",
      );
    }
  }
  await page.evaluate("document.querySelector('[data-prompt-play]').click()");
  await page.evaluate("new Promise(resolve => setTimeout(resolve, 7000))");
  assert.equal(
    await page.evaluate("document.querySelector('[data-prompt-demo]').dataset.example"),
    "2",
    "pause holds the current example beyond the normal cycle",
  );
  await page.evaluate("document.querySelector('[data-prompt-choice=\"0\"]').click()");
  assert.equal(
    await page.evaluate("document.querySelector('[data-prompt-text]').textContent"),
    promptExamples[0].prompt,
  );
  await page.command("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await open("/", "Give your agent a place to show its work.");
  await page.evaluate(
    "document.querySelector('#agent-prompt').scrollIntoView({behavior:'instant',block:'center'})",
  );
  assert.equal(
    await page.evaluate("document.querySelector('[data-prompt-demo]').dataset.paused"),
    "true",
    "reduced motion starts with a static prompt",
  );
  assert.equal(
    await page.evaluate("document.querySelector('[data-prompt-text]').textContent"),
    promptExamples[0].prompt,
  );
  await page.evaluate("document.querySelector('[data-prompt-choice=\"2\"]').click()");
  assert.equal(
    await page.evaluate("document.querySelector('[data-prompt-text]').textContent"),
    promptExamples[2].prompt,
    "reduced motion retains manual selection",
  );
  await page.command("Emulation.setEmulatedMedia", { features: [] });
  await open("/docs/get-started/", "Get started");
  assert.notEqual(
    await page.evaluate("document.documentElement.dataset.theme"),
    theme,
    "theme persists across navigation",
  );
  await page.evaluate("document.querySelector('.theme-toggle').click()");
  await page.evaluate("document.querySelector('.copy-code').click()");
  await eventually(
    () => page.evaluate("document.querySelector('.toast').textContent==='Code copied'"),
    "code copy",
  );
  assert.equal(
    await page.evaluate("navigator.clipboard.readText()"),
    "npx skills add hyperlogue/r3 --skill publish-artifacts-to-r3 --global\n",
  );
  await page.evaluate("document.querySelector('[data-markdown]').click()");
  await eventually(
    () => page.evaluate("document.querySelector('.toast').textContent==='Page copied as Markdown'"),
    "Markdown copy",
  );
  assert((await page.evaluate<string>("navigator.clipboard.readText()")).includes("# Get started"));
  await screenshot("docs-desktop.png");

  await open("/search/?q=feedback", "Search the docs.");
  await eventually(
    () => page.evaluate("document.querySelectorAll('#search-results li').length > 0"),
    "search results",
  );
  assert(
    await page.evaluate(
      `[...document.querySelectorAll('#search-results a')].every(a=>new URL(a.href).pathname.startsWith(${JSON.stringify(`${base}/`)}))`,
    ),
    "search results respect the mount",
  );
  const resultURL = await page.evaluate<string>("document.querySelector('#search-results a').href");
  assert.equal((await fetch(resultURL)).status, 200);
  await page.evaluate(
    "document.querySelector('#search-input').value='\"zzzznoresultszzzz\"';document.querySelector('#search-form').requestSubmit()",
  );
  await eventually(
    () =>
      page.evaluate(
        "document.querySelector('#search-status').textContent.startsWith('No results')",
      ),
    "empty search",
  ).catch(async (error) => {
    console.log(
      await page.evaluate(
        "({status:document.querySelector('#search-status').textContent,query:document.querySelector('#search-input').value,results:document.querySelector('#search-results').textContent})",
      ),
    );
    throw error;
  });

  await viewport(390, 844);
  await open("/", "Give your agent a place to show its work.");
  await noOverflow();
  await screenshot("home-mobile.png");
  await page.evaluate("document.querySelector('.mobile-menu summary').click()");
  assert(await page.evaluate("document.querySelector('.mobile-menu').open"));
  await page.command("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  assert.equal(await page.evaluate("document.querySelector('.mobile-menu').open"), false);
  await open("/docs/get-started/", "Get started");
  await noOverflow();
  await screenshot("docs-mobile.png");
  await page.evaluate("document.querySelector('.mobile-docs summary').click()");
  assert(await page.evaluate("document.querySelector('.mobile-docs').open"));
  await open("/use-cases/prototype/", "Refine a project-creation flow");
  await noOverflow();
  await screenshot("story-mobile.png");
  await viewport(320, 740);
  await noOverflow();

  await page.command("Emulation.setScriptExecutionDisabled", { value: true });
  await open("/", "Give your agent a place to show its work.");
  assert.equal(
    await page.evaluate("document.querySelector('#skill-install code').textContent"),
    "npx skills add hyperlogue/r3 --skill publish-artifacts-to-r3 --global",
    "installation remains readable without JavaScript",
  );
  assert.equal(
    await page.evaluate("document.querySelector('[data-prompt-text]').textContent"),
    promptExamples[0].prompt,
    "the complete example prompt remains readable without JavaScript",
  );
  await noOverflow();
  await open("/docs/get-started/", "Get started");
  assert(await page.evaluate("document.body.textContent.includes('Ask your agent to publish')"));
  assert.equal(
    await page.evaluate("getComputedStyle(document.querySelector('[data-markdown]')).display"),
    "none",
  );
  await page.command("Emulation.setScriptExecutionDisabled", { value: false });

  await viewport(1440);
  await page.command("Page.navigate", {
    url: `${server.url.origin}${base}/demo/artifact_weekend?version=1&file=index.html&view=rendered`,
  });
  await eventually(
    () => page.evaluate("!!document.querySelector('[aria-label=\"Published version\"]')"),
    "demo deep-link fallback",
  );
  assert.equal(
    await page.evaluate("location.pathname+location.search+location.hash"),
    `${base}/demo/artifact_weekend?version=1&file=index.html&view=rendered`,
  );
  await open("/does-not-exist/", "This page isn’t here.");
  assert.equal((await fetch(`${server.url.origin}${base}/does-not-exist/`)).status, 404);
  assert.equal(outside.size, 0, "site makes no third-party requests");
  assert.deepEqual(exceptions, [], "no browser runtime exceptions");
  console.log(
    `Browser checks passed for ${base || "/"}: layouts, themes, copy, search, no-JS docs, and demo deep links.`,
  );
} finally {
  await browser.close();
  server.stop(true);
}
