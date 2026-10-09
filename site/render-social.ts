import { join } from "node:path";
import { openTestBrowser } from "../scripts/browser.ts";

// Rasterize the editable SVG for link-preview services that do not accept SVG.
// Run only when that source changes, with an installed R3_TEST_BROWSER.
const browser = await openTestBrowser();
try {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 1200,
    height: 630,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const { frameTree } = await page.command("Page.getFrameTree");
  const svg = await Bun.file(join(import.meta.dir, "assets/social.svg")).text();
  await page.command("Page.setDocumentContent", {
    frameId: frameTree.frame.id,
    html: `<!doctype html><html><head><style>html,body{margin:0;width:1200px;height:630px;overflow:hidden}svg{display:block}</style></head><body>${svg}</body></html>`,
  });
  await page.evaluate("document.fonts.ready");
  const { data } = await page.command("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(import.meta.dir, "assets/social.png"), Buffer.from(data, "base64"));
  console.log("Rendered site/assets/social.png");
} finally {
  await browser.close();
}
