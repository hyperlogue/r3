import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventually, openTestBrowser } from "../scripts/browser.ts";
import { buildDemo } from "../scripts/build-demo.ts";
import { normalizeBase } from "./render.ts";
import { serveSite } from "./serve.ts";

// Marker translations prove that catalogs drive the actual UI. They exist only
// in this temporary bundle; the source catalogs stay untouched.
const directory = await mkdtemp(join(tmpdir(), "r3-i18n-browser-"));
await buildDemo({
  directory,
  base: "/demo/",
  plugins: [
    {
      name: "i18n-acceptance-markers",
      setup(build) {
        build.onLoad({ filter: /web\/src\/locales\/zh-cn\.json$/ }, async ({ path }) => {
          const catalog = await Bun.file(path.replace("zh-cn.json", "en.json")).json();
          catalog.settings.title = "[ZH] Settings";
          catalog.settings.language = "[ZH] Language";
          catalog.common.artifacts = "[ZH] Artifacts";
          catalog.thread.addComment = "[ZH] Add comment";
          return { loader: "json", contents: JSON.stringify(catalog) };
        });
      },
    },
  ],
});
const base = normalizeBase(process.env.R3_SITE_BASE);
const website = serveSite(join(import.meta.dir, "../dist/pages"), { base, port: 0 });
const demo = serveSite(directory, { base: "/demo", port: 0 });
const browser = await openTestBrowser();
const exceptions: string[] = [];
browser.listen((event) => {
  if (event.method === "Runtime.exceptionThrown")
    exceptions.push(event.params.exceptionDetails.exception?.description ?? "Runtime exception");
});
try {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  await page.command("Page.navigate", {
    url: `${website.url.origin}${base}/zh-cn/search/?q=artifact`,
  });
  await eventually(
    () => page.evaluate("document.querySelectorAll('#search-results a').length > 0"),
    "Chinese website search",
  );
  assert.equal(await page.evaluate("document.documentElement.lang"), "zh-CN");
  assert(
    await page.evaluate(
      `[...document.querySelectorAll('#search-results a')].every(a => new URL(a.href).pathname.startsWith(${JSON.stringify(`${base}/zh-cn/`)}))`,
    ),
    "search stays in the selected language",
  );
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  assert(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"));
  await page.evaluate("document.querySelector('.mobile-menu summary').click()");
  await page.evaluate("document.querySelector('.mobile-menu [data-locale=\"en\"]').click()");
  await eventually(
    () => page.evaluate("document.documentElement?.lang === 'en'"),
    "website language navigation",
  );
  assert.equal(await page.evaluate("new URL(location.href).searchParams.get('q')"), "artifact");

  await page.command("Page.addScriptToEvaluateOnNewDocument", {
    source: "localStorage.setItem('r3-demo-intro-seen', '1')",
  });
  await page.command("Page.navigate", { url: `${demo.url.origin}/demo/` });
  await eventually(
    () => page.evaluate("!!document.querySelector('button[aria-label=\"Settings\"]')"),
    "demo library",
  );
  const second = await browser.send("Target.createTarget", { url: `${demo.url.origin}/demo/` });
  const otherTab = await browser.attach(second.targetId);
  await page.evaluate("document.querySelector('button[aria-label=\"Settings\"]').click()");
  const selectLanguage = async (locale: string) => {
    await page.evaluate(`(() => {
      const select = [...document.querySelectorAll('select')].find(s => s.querySelector('option[value="zh-cn"]'));
      select.value = ${JSON.stringify(locale)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
  };
  await selectLanguage("zh-cn");
  await eventually(
    () => page.evaluate("document.body.textContent.includes('[ZH] Settings')"),
    "translated settings without reload",
  );
  await eventually(
    () => otherTab.evaluate("document.documentElement?.lang === 'zh-CN'"),
    "language synchronization across tabs",
  );
  assert.equal(await page.evaluate("localStorage.getItem('r3-locale')"), "zh-cn");
  await page.command("Page.reload");
  await eventually(
    () => page.evaluate("!!document.querySelector('button[aria-label=\"[ZH] Settings\"]')"),
    "language survives reload",
  );
  await page.evaluate("document.querySelector('button[aria-label=\"[ZH] Settings\"]').click()");
  await selectLanguage("en");
  await page.evaluate("document.querySelector('button[aria-label=\"Close settings\"]').click()");
  await page.evaluate("document.querySelector('a[href*=\"artifact_\"]').click()");
  await eventually(
    () => page.evaluate("!!document.querySelector('[data-mobile-discussion-toggle]')"),
    "workspace navigation",
  );
  await page.evaluate("document.querySelector('[data-mobile-discussion-toggle]').click()");
  await page.evaluate("document.querySelector('button[aria-label=\"Add comment\"]').click()");
  await eventually(
    () => page.evaluate("!!document.querySelector('textarea[placeholder=\"Write a comment…\"]')"),
    "workspace composer",
  );
  await page.evaluate(`(() => {
    const input = document.querySelector('textarea[placeholder="Write a comment…"]');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, 'Draft stays as authored');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  const route = await page.evaluate("location.href");
  await page.evaluate(
    "document.querySelector('button[aria-label=\"Artifact details and actions\"]').click()",
  );
  await page.evaluate(
    "[...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'Settings').click()",
  );
  await selectLanguage("zh-cn");
  assert.equal(await page.evaluate("location.href"), route);
  assert.equal(
    await page.evaluate(
      "document.querySelector('textarea[placeholder=\"Write a comment…\"]').value",
    ),
    "Draft stays as authored",
  );
  assert(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"));
  assert.deepEqual(exceptions, []);
  console.log(
    "Locale routes, search, mobile layout, catalog rendering, persistence, cross-tab updates and drafts passed.",
  );
} finally {
  await browser.close();
  await website.stop(true);
  await demo.stop(true);
  await rm(directory, { recursive: true, force: true });
}
