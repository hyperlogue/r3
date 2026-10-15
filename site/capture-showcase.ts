import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventually, openTestBrowser } from "../scripts/browser.ts";
import { serveSite } from "./serve.ts";
import { buildShowcase } from "./showcase/build.ts";
import { type CaptureManifest, captureSpecs, sha256, verifyCaptures } from "./showcase/captures.ts";
import { verifyWorkspaceFont } from "./showcase/font-check.ts";

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
    for (const spec of captureSpecs) {
      // Each capture gets an independent browser profile and rendering surface.
      const browser = await openTestBrowser();
      try {
        const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
        const page = await browser.attach(targetId);
        const scene = "scene" in spec ? spec.scene : "prototype";
        const comment = scene === "components";
        await page.command("Emulation.setDeviceMetricsOverride", {
          width: spec.width,
          height: spec.height,
          deviceScaleFactor: spec.scale,
          mobile: false,
        });
        await page.command("Page.navigate", {
          url: `${server.url.origin}/example/index.html?theme=${spec.theme}&embedded=1&scene=${scene}`,
        });
        await eventually(
          () =>
            page.evaluate(
              comment
                ? "!!document.querySelector('.component-card')"
                : "!!document.querySelector('[data-artifact-thread]') && !!document.querySelector('.fieldwork-help, .prompt-document-note')",
            ),
          "real workspace and latest revision",
        );
        await verifyWorkspaceFont(page);
        if (comment) {
          await page.evaluate(`document.querySelector('[aria-label="Hide discussion"]').click()`);
          await eventually(
            () => page.evaluate("!!document.querySelector('.component-pin')"),
            "existing component target",
          );
          await page.evaluate("document.querySelector('.component-pin').click()");
          await eventually(
            () => page.evaluate("!!document.querySelector('[data-artifact-thread-popover]')"),
            "existing thread popover",
          );
          await eventually(
            () =>
              page.evaluate(`(() => {
            const action = document.querySelector('.component-action');
            const pin = document.querySelector('.component-pin');
            const thread = document.querySelector('[data-artifact-thread-popover]');
            return action.classList.contains('component-selected') &&
              action.getBoundingClientRect().right < thread.getBoundingClientRect().left &&
              pin.getBoundingClientRect().right < thread.getBoundingClientRect().left;
          })()`),
            "selected button and pin remain visible beside the thread",
          );
          await page.evaluate(
            "document.querySelector('[data-artifact-thread-popover] [data-thread-action=comment]').click()",
          );
          await eventually(
            () =>
              page.evaluate("!!document.querySelector('[data-artifact-thread-popover] textarea')"),
            "thread reply composer",
          );
          await page.evaluate(
            "document.querySelector('[data-artifact-thread-popover] textarea').focus()",
          );
          await page.command("Input.insertText", {
            text: "Please decrease the margin back to 8px.",
          });
          await eventually(
            () =>
              page.evaluate(`(() => {
              const thread = document.querySelector('[data-artifact-thread-popover]');
              return thread.querySelector('[data-artifact-comment=comment_components_fix]') &&
                thread.textContent.includes('Increase the margin above this button to 16px.') &&
                !thread.querySelector('button[type=submit]').disabled &&
                thread.querySelector('textarea').value === 'Please decrease the margin back to 8px.';
            })()`),
            "thread history and unsent reply",
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
        });
        const bytes = Buffer.from(data, "base64");
        await Bun.write(join(assets, spec.file), bytes);
        manifest.captures.push({ ...spec, sha256: sha256(bytes) });
        console.log(
          `Captured ${spec.file}: ${spec.width * spec.scale} × ${spec.height * spec.scale}`,
        );
        await browser.send("Target.closeTarget", { targetId });
      } finally {
        await browser.close();
      }
    }
    await Bun.write(
      join(assets, "fieldwork-captures.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await verifyCaptures(assets);
  } finally {
    server.stop(true);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
