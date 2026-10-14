import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventually, openTestBrowser } from "../scripts/browser.ts";
import { serveSite } from "./serve.ts";
import { buildShowcase } from "./showcase/build.ts";
import { type CaptureManifest, captureSpecs, sha256, verifyCaptures } from "./showcase/captures.ts";

// Build independently so missing captures cannot prevent their own regeneration.
const directory = await mkdtemp(join(tmpdir(), "r3-site-capture-"));
const assets = join(import.meta.dir, "assets");
try {
  await buildShowcase(join(directory, "example"));
  await Bun.write(join(directory, "404.html"), "<!doctype html><title>Not found</title>");
  const manifest: CaptureManifest = {
    captures: [],
  };
  const server = serveSite(directory, { port: 0 });
  try {
    const browser = await openTestBrowser();
    try {
      for (const spec of captureSpecs) {
        // Separate surfaces avoid stale composited text when switching themes.
        const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
        const page = await browser.attach(targetId);
        const comment = "scene" in spec;
        await page.command("Emulation.setDeviceMetricsOverride", {
          width: comment ? 1000 : spec.width,
          height: comment ? 850 : spec.height,
          deviceScaleFactor: spec.scale,
          mobile: false,
        });
        await page.command("Page.navigate", {
          url: `${server.url.origin}/example/index.html?theme=${spec.theme}&embedded=1${comment ? "&scene=components" : ""}`,
        });
        await eventually(
          () =>
            page.evaluate(
              comment
                ? "!!document.querySelector('.component-card')"
                : "!!document.querySelector('[data-artifact-thread]') && !!document.querySelector('.fieldwork-help')",
            ),
          "real workspace and latest revision",
        );
        await page.evaluate("document.fonts.ready");
        if (comment) {
          await page.evaluate(`document.querySelector('[aria-label="Hide discussion"]').click()`);
          await page.evaluate(`document.querySelector('[aria-label="Comment mode"]').click()`);
          await eventually(
            () => page.evaluate("!!document.querySelector('.component-action')"),
            "comment mode",
          );
          await page.evaluate("document.querySelector('.component-action').click()");
          await eventually(
            () => page.evaluate("!!document.querySelector('[data-floating-composer] textarea')"),
            "floating composer",
          );
          await page.evaluate(
            "document.querySelector('[data-floating-composer] textarea').focus()",
          );
          await page.command("Input.insertText", {
            text: "Increase the margin above this button to 16px.",
          });
          await page.evaluate(
            "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
          );
          await eventually(
            () =>
              page.evaluate(`(() => {
              const composer = document.querySelector('[data-floating-composer]');
              return !composer.querySelector('button[type=submit]').disabled && composer.getBoundingClientRect().top > document.querySelector('.component-action').getBoundingClientRect().bottom;
            })()`),
            "draft ready to send below the selected region",
          );
        }
        await page.evaluate(
          "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
        );
        await page.evaluate(
          "Promise.all(document.getAnimations().map(animation => animation.finished))",
        );
        // Let Chromium paint newly enabled controls in the floating layer.
        if (comment) await page.evaluate("new Promise(resolve => setTimeout(resolve, 500))");
        const { data } = await page.command("Page.captureScreenshot", {
          format: "png",
          ...(comment
            ? { clip: { x: 240, y: 80, width: spec.width, height: spec.height, scale: 1 } }
            : {}),
        });
        const bytes = Buffer.from(data, "base64");
        await Bun.write(join(assets, spec.file), bytes);
        manifest.captures.push({ ...spec, sha256: sha256(bytes) });
        console.log(
          `Captured ${spec.file}: ${spec.width * spec.scale} × ${spec.height * spec.scale}`,
        );
        await browser.send("Target.closeTarget", { targetId });
      }
      await Bun.write(
        join(assets, "fieldwork-captures.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      await verifyCaptures(assets);
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
