import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { eventually, openTestBrowser } from "../scripts/browser.ts";
import { normalizeBase } from "./render.ts";
import { serveSite } from "./serve.ts";

const base = normalizeBase(process.env.R3_SITE_BASE);
const server = serveSite(join(import.meta.dir, "../dist/pages"), { base, port: 0 });
const browser = await openTestBrowser();
const scenes = ["prototype", "proposal", "explanation", "code-review", "media"];
const review = join(import.meta.dir, "../dist/site-review");
await mkdir(review, { recursive: true });
const failures: string[] = [];
browser.listen((event) => {
  if (event.method === "Runtime.exceptionThrown") failures.push(event.params.exceptionDetails.text);
});
try {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  for (const width of [1440, 390, 320]) {
    await page.command("Emulation.setDeviceMetricsOverride", {
      width,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const scene of scenes) {
      const path = `${base}/use-cases/${scene}/`;
      await page.command("Page.navigate", { url: `${server.url.origin}${path}` });
      await eventually(
        () =>
          page.evaluate(`location.pathname === '${path}' && document.readyState === 'complete'`),
        "walkthrough loads",
      );
      for (const theme of ["light", "dark"]) {
        await page.evaluate(`document.documentElement.dataset.theme = '${theme}'`);
        await page.evaluate(
          "Promise.all([...document.querySelectorAll('.story-screenshot img')].map(img => {img.loading = 'eager'; return img.decode();}))",
        );
        const result = await page.evaluate(`(() => {
          const figures = [...document.querySelectorAll('.story-screenshot')];
          const links = figures.map(figure => [...figure.querySelectorAll('a')].filter(link => getComputedStyle(link).display !== 'none')).flat();
          return { count: figures.length, links: links.map(link => link.href), sources: links.map(link => link.querySelector('img').src),
            words: document.querySelector('.prose').innerText.trim().split(/\\s+/).length,
            overflow: document.documentElement.scrollWidth > innerWidth,
            dimensions: links.every(link => { const img = link.querySelector("img"); return img.naturalWidth === Number(img.getAttribute("width")) * 3 && img.naturalHeight === Number(img.getAttribute("height")) * 3; }),
            width: document.querySelector('.story-screenshot').getBoundingClientRect().width };
        })()`);
        assert.equal(result.count, 3, `${scene}: three real screenshots`);
        assert.equal(new Set(result.sources).size, 3, `${scene}: distinct images`);
        assert.deepEqual(result.links, result.sources, "full-size links match visible images");
        assert(
          result.sources.every((src: string) => src.endsWith(`-${theme}.png`)),
          "image theme follows page theme",
        );
        assert(result.dimensions, "image dimensions match their recorded capture viewport");
        assert(!result.overflow, `${scene}: fits ${width}px`);
        if (width === 1440) {
          assert(result.width >= 1000, "desktop screenshots have room for readable UI");
          for (const url of result.links)
            assert((await fetch(url)).ok, "full-size capture is served beneath the mount");
          if (theme === "light") console.log(`${scene}: ${result.words} words; 3 screenshots`);
        }
        if (width !== 320) {
          const { data } = await page.command("Page.captureScreenshot", { format: "png" });
          await Bun.write(
            join(review, `story-${scene}-${width}-${theme}.png`),
            Buffer.from(data, "base64"),
          );
        }
      }
      const markdown = await fetch(`${server.url.origin}${path}index.md`).then((response) =>
        response.text(),
      );
      assert.equal(
        (markdown.match(/!\[/g) ?? []).length,
        3,
        "Markdown exports include three screenshots",
      );
      assert(!markdown.includes("-dark.png"), "Markdown avoids duplicate theme images");
    }
  }
  assert.deepEqual(failures, [], "no browser runtime errors");
  console.log("Story pages pass at 1440, 390 and 320px in both themes.");
} finally {
  await browser.close();
  server.stop(true);
}
