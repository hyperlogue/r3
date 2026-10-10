import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eventually, openTestBrowser } from "../scripts/browser.ts";
import { serveSite } from "./serve.ts";
import { buildShowcase } from "./showcase/build.ts";
import {
  type CaptureManifest,
  captureSpecs,
  sha256,
  showcaseHash,
  verifyCaptures,
} from "./showcase/captures.ts";

// Build independently so stale captures cannot prevent their own regeneration.
const directory = await mkdtemp(join(tmpdir(), "r3-site-capture-"));
const assets = join(import.meta.dir, "assets");
try {
  await buildShowcase(join(directory, "example"));
  await Bun.write(join(directory, "404.html"), "<!doctype html><title>Not found</title>");
  const manifest: CaptureManifest = {
    bundleHash: await showcaseHash(join(directory, "example")),
    captures: [],
  };
  const server = serveSite(directory, { port: 0 });
  try {
    const browser = await openTestBrowser();
    try {
      const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
      const page = await browser.attach(targetId);
      for (const spec of captureSpecs) {
        await page.command("Emulation.setDeviceMetricsOverride", {
          width: spec.width,
          height: spec.height,
          deviceScaleFactor: spec.scale,
          mobile: false,
        });
        await page.command("Page.navigate", {
          url: `${server.url.origin}/example/index.html?theme=${spec.theme}&embedded=1`,
        });
        await eventually(
          () =>
            page.evaluate(
              "!!document.querySelector('[data-artifact-discussions]') && !!document.querySelector('.fieldwork-help')",
            ),
          "real workspace and latest revision",
        );
        await page.evaluate("document.fonts.ready");
        await page.evaluate(
          "Promise.all(document.getAnimations().map(animation => animation.finished))",
        );
        const { data } = await page.command("Page.captureScreenshot", { format: "png" });
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
      await verifyCaptures(manifest.bundleHash, assets);
    } finally {
      await browser.close();
    }
  } finally {
    server.stop(true);
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}
