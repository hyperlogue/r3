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
  const svgPath = join(import.meta.dir, "assets/social.svg");
  const source = await Bun.file(svgPath).text();
  const logoImage = /(<image id="project-logo"[^>]*href=")[^"]*(")/;
  if (!logoImage.test(source)) throw new Error("Social artwork is missing its project logo");
  const logo = await Bun.file(join(import.meta.dir, "../web/favicon.svg")).arrayBuffer();
  const svg = source.replace(
    logoImage,
    (_, before, after) =>
      `${before}data:image/svg+xml;base64,${Buffer.from(logo).toString("base64")}${after}`,
  );
  await Bun.write(svgPath, svg);
  await page.command("Page.setDocumentContent", {
    frameId: frameTree.frame.id,
    html: `<!doctype html><html><head><style>html,body{margin:0;width:1200px;height:630px;overflow:hidden}svg{display:block}</style></head><body>${svg}</body></html>`,
  });
  await page.evaluate("document.fonts.ready");
  await page.evaluate(`Promise.all([...document.querySelectorAll('svg image')].map(element => {
    const image = new Image();
    image.src = element.href.baseVal;
    return image.decode();
  }))`);
  const { data } = await page.command("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(import.meta.dir, "assets/social.png"), Buffer.from(data, "base64"));
  console.log("Rendered site/assets/social.png");
} finally {
  await browser.close();
}
