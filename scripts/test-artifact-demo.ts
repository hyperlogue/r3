import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import { eventually, openTestBrowser } from "./browser.ts";

// Build with R3_DEMO_BASE=/r3/demo, then run stage:pages before this check.
const root = resolve("dist/pages");
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname.replace(/^\/r3(?=\/|$)/, "");
    const path = resolve(root, `.${pathname}`);
    if (path !== root && !path.startsWith(root + sep)) return new Response(null, { status: 404 });
    const file = Bun.file(path);
    return path !== root && (await file.exists())
      ? new Response(file)
      : new Response(Bun.file(resolve(root, "404.html")));
  },
});
let browser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
try {
  browser = await openTestBrowser();
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  await page.command("Page.enable");
  await page.command("Runtime.enable");
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 1400,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.command("Page.navigate", { url: new URL("/r3/demo/", server.url).href });
  await eventually(
    () => page.evaluate("document.body?.textContent.includes('Design a published workspace')"),
    "demo artifact home",
  );
  await page.evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Explore'))?.click()",
  );
  await page.evaluate(
    "Array.from(document.querySelectorAll('a')).find(a=>a.textContent.includes('Design a published workspace')).click()",
  );
  await eventually(
    () =>
      page.evaluate("document.querySelector('[aria-label=\"Published version\"]')?.value==='1'"),
    "demo first version",
  );
  await eventually(
    () => page.evaluate("!!document.querySelector('[aria-label=\"Feedback\"]')"),
    "composer",
  );
  await page.evaluate("document.querySelector('[aria-label=\"Feedback\"]').focus()");
  await page.command("Input.insertText", {
    text: "Please keep the version I am reading selected.",
  });
  await page.evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Add feedback').click()",
  );
  await eventually(
    () =>
      page.evaluate(
        "!!document.querySelector('[data-feedback-id]') || document.body?.textContent.includes('Please keep the version I am reading selected.')",
      ),
    "saved feedback",
  );
  await page.evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim()==='Submit').click()",
  );
  await eventually(
    () =>
      page.evaluate(
        "document.querySelector('[aria-label=\"Published version\"]')?.dataset.versionCount==='2'",
      ),
    "scripted publication",
  );
  assert.equal(
    await page.evaluate("document.querySelector('[aria-label=\"Published version\"]').value"),
    "1",
  );
  assert(await page.evaluate("document.body.textContent.includes('scripted demo reply')"));
  await page.command("Page.reload");
  await eventually(
    () =>
      page.evaluate(
        "document.querySelector('[aria-label=\"Published version\"]')?.dataset.versionCount==='2' && document.body?.textContent.includes('scripted demo reply')",
      ),
    "Pages deep-link reload and retained storage",
  );
  console.log(
    "Static demo under /r3/demo including deep-link reload: publication, human feedback, scripted reply, retained selected version passed",
  );
  if (process.env.R3_TEST_SCREENSHOT) {
    const shot = await page.command("Page.captureScreenshot", { format: "png" });
    await Bun.write(process.env.R3_TEST_SCREENSHOT, Buffer.from(shot.data, "base64"));
  }
} finally {
  await browser?.close();
  server.stop(true);
}
