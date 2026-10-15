import assert from "node:assert/strict";
import { join } from "node:path";
import { eventually, openTestBrowser } from "../scripts/browser.ts";
import { normalizeBase } from "./render.ts";
import { serveSite } from "./serve.ts";
import { prepareMediaCapture } from "./showcase/media-capture.ts";

const base = normalizeBase(process.env.R3_SITE_BASE);
const server = serveSite(join(import.meta.dir, "../dist/pages"), { base, port: 0 });
const browser = await openTestBrowser();
const errors: string[] = [];
browser.listen((event) => {
  if (event.method === "Runtime.exceptionThrown") errors.push(event.params.exceptionDetails.text);
});
try {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  const viewport = (width: number, height = 900) =>
    page.command("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  for (const width of [1440, 390, 320]) {
    await viewport(width);
    for (const theme of ["light", "dark"]) {
      await page.command("Page.navigate", {
        url: `${server.url.origin}${base}/use-cases/media/?theme=${theme}`,
      });
      await eventually(
        () =>
          page.evaluate(
            "document.readyState === 'complete' && document.querySelectorAll('.doc-screenshot').length === 3",
          ),
        "three screenshot walkthrough",
      );
      await page.evaluate(
        "document.querySelector('.doc-screenshot').scrollIntoView({block:'center',behavior:'instant'}); document.querySelectorAll('.doc-screenshot img').forEach(img=>img.loading='eager')",
      );
      await eventually(
        () =>
          page.evaluate(
            "[...document.querySelectorAll('.doc-screenshot img')].every(img => img.complete && img.naturalWidth === 3000)",
          ),
        "all retained screenshots decoded",
      );
      assert(
        await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
        "walkthrough fits viewport",
      );
      assert.equal(await page.evaluate(`document.querySelectorAll('.doc-${theme}').length`), 3);
      const { data } = await page.command("Page.captureScreenshot", { format: "png" });
      await Bun.write(
        join(import.meta.dir, `../dist/site-review/media-page-${width}-${theme}.png`),
        Buffer.from(data, "base64"),
      );
    }
  }
  await viewport(1000, 600);
  for (const video of [false, true]) {
    const kind = video ? "video" : "image";
    await page.command("Page.navigate", {
      url: `${server.url.origin}${base}/example/index.html?scene=${video ? "media-video" : "media"}&embedded=1`,
    });
    await prepareMediaCapture(page, video);
    assert.equal(
      await page.evaluate("document.querySelectorAll('[data-artifact-thread]').length"),
      1,
    );
    if (video) {
      assert.equal(await page.evaluate("document.querySelector('video').duration"), 6);
      assert.equal(await page.evaluate("document.querySelector('video').currentTime"), 2);
      await page.evaluate("document.querySelector('[aria-label=\"Play video\"]').click()");
      await eventually(
        () => page.evaluate("document.querySelector('video').currentTime > 2.2"),
        "actual clip playback advances",
      );
      await page.evaluate("document.querySelector('[aria-label=\"Pause video\"]').click()");
    }
    await page.evaluate(
      `document.querySelector('[data-compare-comment="comment_launch_${kind}_fix"]').click()`,
    );
    await eventually(
      () =>
        page.evaluate(
          "document.querySelectorAll('[data-artifact-comparison] img[alt=\"Saved frame\"]').length === 2 && [...document.querySelectorAll('[data-artifact-comparison] img')].every(img=>img.naturalWidth===960)",
        ),
      "native comparison retains both frames",
    );
    const pixels =
      await page.evaluate(`Array.from(document.querySelectorAll('[data-artifact-comparison] img[alt="Saved frame"]'), image => {
      const canvas=document.createElement('canvas'); canvas.width=960; canvas.height=540;
      const ctx=canvas.getContext('2d'); ctx.drawImage(image,0,0);
      return Array.from(ctx.getImageData(70,430,1,1).data).slice(0,3);
    })`);
    assert(
      pixels[0][0] > 200 && pixels[1][0] < 80,
      "comparison shows the original background and the darker revised label",
    );
    if (video) {
      assert.deepEqual(
        await page.evaluate(
          "[...document.querySelectorAll('[data-artifact-comparison] video')].map(video=>video.duration)",
        ),
        [6, 8],
      );
    }
  }
  assert.deepEqual(errors, []);
  console.log(
    "Media walkthrough layouts, saved frames, image/video comparisons, and 6s/8s clip playback passed.",
  );
} finally {
  await browser.close();
  server.stop(true);
}
