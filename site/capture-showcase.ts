import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventually, openTestBrowser } from "../scripts/browser.ts";
import { serveSite } from "./serve.ts";
import {
  annotationState,
  clearCaptureFocus,
  clickAnnotation,
  componentFrames,
} from "./showcase/browser.ts";
import { buildShowcase } from "./showcase/build.ts";
import { type CaptureManifest, captureSpecs, sha256, verifyCaptures } from "./showcase/captures.ts";
import { verifyWorkspaceFont } from "./showcase/font-check.ts";
import { prepareMediaCapture } from "./showcase/media-capture.ts";
import { prepareStoryCapture } from "./showcase/story-capture.ts";

// Build independently so missing captures cannot prevent their own regeneration.
const directory = await mkdtemp(join(tmpdir(), "r3-site-capture-"));
const assets = join(import.meta.dir, "assets");
try {
  await buildShowcase(join(directory, "example"));
  await Bun.write(join(directory, "404.html"), "<!doctype html><title>Not found</title>");
  const storiesOnly = process.argv.includes("--stories");
  const selectedScene = process.argv.find((arg) => arg.startsWith("--scene="))?.slice(8);
  if (
    selectedScene &&
    !captureSpecs.some((spec) => "scene" in spec && spec.scene === selectedScene)
  )
    throw new Error(`Unknown capture scene: ${selectedScene}`);
  const manifest: CaptureManifest =
    storiesOnly || selectedScene
      ? await Bun.file(join(assets, "fieldwork-captures.json")).json()
      : {
          captures: (
            (await Bun.file(join(assets, "fieldwork-captures.json")).json()) as CaptureManifest
          ).captures.filter((capture) => "recorded" in capture),
        };
  const server = serveSite(directory, { port: 0 });
  try {
    for (const spec of captureSpecs.filter(
      (spec) =>
        !("recorded" in spec) &&
        (!storiesOnly || "step" in spec) &&
        (!selectedScene || ("scene" in spec && spec.scene === selectedScene)),
    )) {
      // Each capture gets an independent browser profile and rendering surface.
      // Separate iframe renderers inherit the browser scale, not the parent's
      // DevTools override. Keep authored content as sharp as the surrounding UI.
      const browser = await openTestBrowser([`--force-device-scale-factor=${spec.scale}`]);
      try {
        const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
        const page = await browser.attach(targetId);
        const scene = "scene" in spec ? spec.scene : "prototype";
        const comment = scene === "components";
        const media = scene === "media" || scene === "media-video";
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
              "step" in spec
                ? "!!document.querySelector('[data-artifact-thread]')"
                : media
                  ? "!!document.querySelector('[data-native-media]')"
                  : comment
                    ? "!!document.querySelector('.component-preview')"
                    : "!!document.querySelector('[data-artifact-thread]') && !!document.querySelector('.fieldwork-help, .prompt-document-note')",
            ),
          "real workspace and latest revision",
        );
        await verifyWorkspaceFont(page);
        if (spec.width < 768) {
          // Show the authored example instead of covering it with the phone sheet.
          await page.evaluate(`document.querySelector('[aria-label="Close discussion"]').click()`);
          await eventually(
            () => page.evaluate(`document.querySelector('[data-mobile-discussion="sheet"]').inert`),
            "mobile discussion closes before capturing the document",
          );
        }
        if ("step" in spec) {
          await prepareStoryCapture(browser, page, spec.scene, spec.step);
        } else if (media) {
          await prepareMediaCapture(page, scene === "media-video", "mediaComparison" in spec);
          await clearCaptureFocus(page);
        } else if ("comparison" in spec) {
          const [frame] = await componentFrames(browser, page);
          await verifyWorkspaceFont(frame!);
          await page.evaluate(
            `document.querySelector('[data-compare-comment="comment_components_fix"]').click()`,
          );
          const frames = await componentFrames(browser, page, 2);
          for (const compared of frames) await verifyWorkspaceFont(compared);
        } else if (comment) {
          const [frame] = await componentFrames(browser, page);
          await verifyWorkspaceFont(frame!);
          if ((await frame!.evaluate("devicePixelRatio")) !== spec.scale)
            throw new Error("The component document must render at the capture pixel density");
          await page.evaluate(
            "[...document.querySelectorAll('[data-artifact-comment=comment_components_fix] button')].find(button => button.textContent.includes('Fix:')).click()",
          );
          await page.evaluate(`document.querySelector('[aria-label="Hide discussion"]').click()`);
          await clickAnnotation(frame!, "marker");
          await eventually(
            () => page.evaluate("!!document.querySelector('[data-artifact-thread-popover]')"),
            "existing thread popover",
          );
          await eventually(async () => {
            const box = await annotationState(frame!, "box");
            const marker = await annotationState(frame!, "marker");
            const { left, edge } = await page.evaluate(
              `({left: document.querySelector('.component-preview').getBoundingClientRect().left, edge:document.querySelector('[data-artifact-thread-popover]').getBoundingClientRect().left})`,
            );
            return (
              box &&
              !box.hidden &&
              marker &&
              !marker.hidden &&
              box.rect.right + left < edge &&
              marker.rect.right + left < edge
            );
          }, "native highlight and comment marker remain visible beside the thread");
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
        manifest.captures = manifest.captures.filter((item) => item.file !== spec.file);
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
