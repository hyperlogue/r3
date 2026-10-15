import assert from "node:assert/strict";
import { join } from "node:path";
import { eventually, openTestBrowser } from "../scripts/browser.ts";
import { docsStart, navigationDocs } from "./catalog.ts";
import { normalizeBase } from "./render.ts";
import { serveSite } from "./serve.ts";

const base = normalizeBase(process.env.R3_SITE_BASE);
const server = serveSite(join(import.meta.dir, "../dist/pages"), { base, port: 0 });
const browser = await openTestBrowser();
try {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  const open = async (path: string) => {
    await page.command("Page.navigate", { url: `${server.url.origin}${base}${path}` });
    await eventually(
      () =>
        page.evaluate(
          `location.pathname === ${JSON.stringify(`${base}${path}`)} && document.readyState === 'complete'`,
        ),
      path,
    );
  };
  for (const width of [1440, 390, 320]) {
    await page.command("Emulation.setDeviceMetricsOverride", {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const doc of [docsStart, ...navigationDocs]) {
      await open(doc.path);
      for (const theme of ["light", "dark"]) {
        await page.evaluate(`document.documentElement.dataset.theme = '${theme}'`);
        await page.evaluate(
          "Promise.all([...document.querySelectorAll('.doc-capture img')].map(img => { img.loading = 'eager'; return img.decode(); }))",
        );
        assert(
          await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
          `${doc.path} fits ${width}px in ${theme} theme`,
        );
        assert(
          await page.evaluate(`!!document.querySelector('.docs-shell .article h1') &&
            !!document.querySelector('nav[aria-label="Documentation"] a[aria-current="page"]')`),
          "the document has navigation and an active page",
        );
        if (
          [
            "/docs/",
            "/docs/feedback/",
            "/docs/review-loop/",
            "/docs/diffs/",
            "/docs/permissions/",
            "/docs/revisions/",
            "/docs/navigation/",
          ].includes(doc.path)
        ) {
          const { data } = await page.command("Page.captureScreenshot", { format: "png" });
          await Bun.write(
            join(
              import.meta.dir,
              `../dist/site-review/docs-${doc.path.split("/").filter(Boolean).at(-1)}-${width}-${theme}.png`,
            ),
            Buffer.from(data, "base64"),
          );
        }
      }
    }
  }
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await open("/");
  await page.evaluate("document.querySelector('.desktop-nav a[href$=\"/docs/\"]').click()");
  await eventually(
    () => page.evaluate("document.querySelector('.docs-shell h1')?.textContent === 'Get started'"),
    "Docs goes directly to the guide",
  );
  assert.equal(await page.evaluate("document.querySelector('.docs-directory')"), null);
  await page.command("Emulation.setScriptExecutionDisabled", { value: true });
  await open("/docs/");
  assert(
    await page.evaluate(
      "!!document.querySelector('#install-the-skill') && !!document.querySelector('.mobile-docs')",
    ),
    "direct docs entry works without JavaScript",
  );
  console.log(
    "Documentation checks passed: direct entry, active navigation, all human pages at desktop/phone widths, both themes, loaded screenshots, and no-JS entry.",
  );
} finally {
  await browser.close();
  server.stop(true);
}
