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
      const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
      const page = await browser.attach(targetId);
      for (const spec of captureSpecs) {
        const comment = "scene" in spec;
        await page.command("Emulation.setDeviceMetricsOverride", {
          width: comment ? 1000 : spec.width,
          height: comment ? 850 : spec.height,
          deviceScaleFactor: spec.scale,
          mobile: false,
        });
        await page.command("Page.navigate", {
          url: `${server.url.origin}/example/index.html?theme=${spec.theme}&embedded=1${comment ? "&scene=comment" : ""}`,
        });
        await eventually(
          () =>
            page.evaluate(
              comment
                ? "!!document.querySelector('.fieldwork-visibility')"
                : "!!document.querySelector('[data-artifact-thread]') && !!document.querySelector('.fieldwork-help')",
            ),
          "real workspace and latest revision",
        );
        await page.evaluate("document.fonts.ready");
        if (comment) {
          await page.evaluate(`document.querySelector('[aria-label="Hide discussion"]').click()`);
          await page.evaluate(`document.querySelector('[aria-label="Comment mode"]').click()`);
          await eventually(
            () => page.evaluate("!!document.querySelector('.fieldwork-anchor')"),
            "comment mode",
          );
          await page.evaluate("document.querySelector('.fieldwork-anchor').click()");
          await eventually(
            () => page.evaluate("!!document.querySelector('[data-floating-composer] textarea')"),
            "floating composer",
          );
          await page.evaluate(
            "document.querySelector('[data-floating-composer] textarea').focus()",
          );
          await page.command("Input.insertText", {
            text: "Explain who can see this project before I create it.",
          });
          await page.evaluate(
            "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
          );
          // Use the real drag handle to leave the selected element visible above the note.
          const handle = await page.evaluate<{ x: number; y: number; dy: number }>(`(() => {
            const handle = document.querySelector('[aria-label="Move composer"]').getBoundingClientRect();
            const composer = document.querySelector('[data-floating-composer]').getBoundingClientRect();
            const target = document.querySelector('.fieldwork-visibility').getBoundingClientRect();
            return { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2, dy: target.bottom + 16 - composer.top };
          })()`);
          await page.command("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: handle.x,
            y: handle.y,
          });
          await page.command("Input.dispatchMouseEvent", {
            type: "mousePressed",
            x: handle.x,
            y: handle.y,
            button: "left",
            buttons: 1,
            clickCount: 1,
          });
          for (const fraction of [0.2, 0.5, 1]) {
            await page.command("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: handle.x,
              y: handle.y + handle.dy * fraction,
              button: "left",
              buttons: 1,
            });
            await page.evaluate("new Promise(resolve => requestAnimationFrame(resolve))");
          }
          await page.command("Input.dispatchMouseEvent", {
            type: "mouseReleased",
            x: handle.x,
            y: handle.y + handle.dy,
            button: "left",
            clickCount: 1,
          });
          await eventually(
            () =>
              page.evaluate(`(() => {
              const composer = document.querySelector('[data-floating-composer]');
              return !composer.querySelector('button[type=submit]').disabled && composer.getBoundingClientRect().top > document.querySelector('.fieldwork-visibility').getBoundingClientRect().bottom;
            })()`),
            "draft ready to send below the selected region",
          );
          const send = await page.evaluate<{ x: number; y: number }>(
            `(() => { const r = document.querySelector('[data-floating-composer] button[type=submit]').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`,
          );
          await page.command("Input.dispatchMouseEvent", { type: "mouseMoved", ...send });
        }
        await page.evaluate(
          "Promise.all(document.getAnimations().map(animation => animation.finished))",
        );
        const { data } = await page.command("Page.captureScreenshot", {
          format: "png",
          ...(comment
            ? { clip: { x: 240, y: 400, width: spec.width, height: spec.height, scale: 1 } }
            : {}),
        });
        const bytes = Buffer.from(data, "base64");
        await Bun.write(join(assets, spec.file), bytes);
        manifest.captures.push({ ...spec, sha256: sha256(bytes) });
        console.log(
          `Captured ${spec.file}: ${spec.width * spec.scale} × ${spec.height * spec.scale}`,
        );
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
