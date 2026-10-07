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
    () =>
      page.evaluate("document.body?.textContent.includes('Keep feedback on its original version')"),
    "demo artifact home",
  );
  await page.evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Explore'))?.click()",
  );
  assert(
    await page.evaluate("!document.body.textContent.includes('Design a published workspace')"),
  );
  assert(await page.evaluate("document.body.textContent.includes('Curve lab — a little closer')"));
  await page.evaluate(
    "Array.from(document.querySelectorAll('a')).find(a=>a.textContent.includes('Keep feedback on its original version')).click()",
  );
  await eventually(
    () =>
      page.evaluate("document.querySelector('[aria-label=\"Published version\"]')?.value==='1'"),
    "demo first version",
  );
  await eventually(
    () => page.evaluate("document.querySelectorAll('[data-file]').length === 6"),
    "six captured diff files",
  );
  await page.evaluate("document.querySelector('[aria-label=\"Add general feedback\"]').click()");
  await eventually(
    () => page.evaluate("!!document.querySelector('[aria-label=\"Feedback\"]')"),
    "composer",
  );
  await page.evaluate("document.querySelector('[aria-label=\"Feedback\"]').focus()");
  await page.command("Input.insertText", {
    text: "Please keep the version I am reading selected.",
  });
  await page.evaluate(`new Promise(resolve => {
    const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
    canvas.getContext('2d').fillRect(0, 0, 16, 16);
    canvas.toBlob(blob => {
      const data = new DataTransfer();
      data.items.add(new File([blob], 'practice.png', {type: 'image/png'}));
      document.querySelector('[aria-label="Feedback"]').dispatchEvent(
        new ClipboardEvent('paste', {bubbles: true, cancelable: true, clipboardData: data}));
      resolve(true);
    }, 'image/png');
  })`);
  await eventually(
    () => page.evaluate("document.querySelector('[data-artifact-composer] img')?.naturalWidth > 0"),
    "practice image preview",
  );
  await page.evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent==='Add feedback').click()",
  );
  await eventually(
    () =>
      page.evaluate(
        "Array.from(document.querySelectorAll('[data-artifact-feedback]')).some(card => card.textContent.includes('Please keep the version I am reading selected.'))",
      ),
    "saved feedback",
  );
  await eventually(
    () =>
      page.evaluate(
        "Array.from(document.querySelectorAll('[data-artifact-feedback] img')).some(image => image.naturalWidth === 16)",
      ),
    "saved practice image served from memory",
  );
  await page.evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim().startsWith('Send to agent')).click()",
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
  await page.evaluate("document.querySelector('[aria-label=\"Add general feedback\"]').click()");
  await eventually(
    () => page.evaluate("!!document.querySelector('[aria-label=\"Feedback\"]')"),
    "unsent practice draft",
  );
  await page.evaluate("document.querySelector('[aria-label=\"Feedback\"]').focus()");
  await page.command("Input.insertText", { text: "Discard this draft on reload." });
  await Bun.sleep(500);
  await page.command("Page.reload");
  await eventually(
    () =>
      page.evaluate(
        "document.querySelector('[aria-label=\"Published version\"]')?.dataset.versionCount==='1' && !document.body?.textContent.includes('scripted demo reply') && !document.body?.textContent.includes('Please keep the version I am reading selected.')",
      ),
    "Pages deep-link reload resets practice state",
  );
  assert.equal(
    await page.evaluate("document.querySelector('[aria-label=\"Feedback\"]')?.value ?? ''"),
    "",
    "reload discards unsent practice drafts",
  );
  console.log(
    "Static demo under /r3/demo including deep-link reload: publication, human feedback, scripted reply, selected version stays pinned until reload, practice state resets passed",
  );
  if (process.env.R3_TEST_SCREENSHOT) {
    const shot = await page.command("Page.captureScreenshot", { format: "png" });
    await Bun.write(process.env.R3_TEST_SCREENSHOT, Buffer.from(shot.data, "base64"));
  }
} finally {
  await browser?.close();
  server.stop(true);
}
