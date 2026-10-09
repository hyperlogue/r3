import assert from "node:assert/strict";
import { join, resolve, sep } from "node:path";
import { eventually, openTestBrowser } from "../scripts/browser.ts";
import { previewPolicy } from "../server/preview-contexts.ts";

const directory = resolve(import.meta.dir, "../dist/site-artifact");
const id = `p${"1".repeat(48)}`,
  prefix = `/__r3_preview/${id}/files/`;
const requests: string[] = [];
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/")
      return new Response(
        `<!doctype html><style>html,body{margin:0}iframe{width:100vw;height:100vh;border:0}</style><iframe sandbox="allow-scripts" src="${prefix}index.html"></iframe>`,
        { headers: { "content-type": "text/html" } },
      );
    if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
    requests.push(url.pathname);
    if (!url.pathname.startsWith(prefix)) return new Response("Not found", { status: 404 });
    const path = resolve(directory, decodeURIComponent(url.pathname.slice(prefix.length)));
    if (!path.startsWith(directory + sep)) return new Response("Not found", { status: 404 });
    const file = Bun.file(path);
    if (!(await file.exists())) return new Response("Not found", { status: 404 });
    const headers = previewPolicy({
      id,
      artifactId: "artifact_site_check",
      versionSeq: 1,
      entryPath: "index.html",
      presentation: "document",
      expiresAt: Date.now() + 60_000,
      origin: server.url.origin,
      applicationOrigin: server.url.origin,
      network: "compatible",
    });
    headers.set("content-type", file.type);
    headers.set("access-control-allow-origin", "*");
    return new Response(file, { headers });
  },
});
const browser = await openTestBrowser();
const exceptions: string[] = [];
browser.listen((e) => {
  if (e.method === "Runtime.exceptionThrown")
    exceptions.push(
      e.params.exceptionDetails.exception?.description || e.params.exceptionDetails.text,
    );
});
try {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 960,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.command("Page.navigate", { url: server.url.href });
  const frames = new Map<string, Awaited<ReturnType<typeof browser.attach>>>();
  async function content(heading: string) {
    return eventually(async () => {
      for (const target of (await browser.send("Target.getTargets")).targetInfos) {
        if (target.type !== "iframe" || !target.url.includes(prefix)) continue;
        if (!frames.has(target.targetId))
          frames.set(target.targetId, await browser.attach(target.targetId));
        const frame = frames.get(target.targetId)!;
        try {
          if (
            await frame.evaluate(
              `document.readyState==='complete' && document.body?.dataset.artifact==='true' && document.querySelector('h1')?.textContent.includes(${JSON.stringify(heading)})`,
            )
          )
            return frame;
        } catch {}
      }
      return null;
    }, heading);
  }
  let doc = await content("See the work.");
  assert.equal(
    await doc.evaluate("getComputedStyle(document.body).fontFamily"),
    'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  );
  assert.equal(
    await doc.evaluate('getComputedStyle(document.querySelector(".workspace-example")).boxShadow'),
    "none",
  );
  await doc.evaluate('document.querySelector(".theme-toggle").click()');
  await doc.evaluate("Promise.all(document.getAnimations().map(a=>a.finished))");
  assert.equal(
    await doc.evaluate('getComputedStyle(document.querySelector(".button.primary")).color'),
    "rgb(255, 255, 255)",
  );
  const { data } = await page.command("Page.captureScreenshot", { format: "png" });
  await Bun.write(
    join(import.meta.dir, "../dist/site-review/artifact-dark.png"),
    Buffer.from(data, "base64"),
  );
  await doc.evaluate('document.querySelector(".header-start").click()');
  doc = await content("Get started");
  assert.equal(await doc.evaluate("document.documentElement.dataset.theme"), "dark");
  assert(
    (
      await doc.evaluate(
        'fetch(document.querySelector("[data-markdown]").dataset.markdown).then(r=>r.text())',
      )
    ).includes("# Get started"),
  );
  await doc.evaluate('document.querySelector(".search-link").click()');
  doc = await content("Search the docs.");
  await doc.evaluate(
    'document.querySelector("#search-input").value="feedback";document.querySelector("#search-form button").click()',
  );
  await eventually(
    () => doc.evaluate('document.querySelectorAll("#search-results li").length>0'),
    "opaque search results",
  );
  assert(
    await doc.evaluate(
      `Array.from(document.querySelectorAll('#search-results a')).every(a=>new URL(a.href).pathname.startsWith(${JSON.stringify(prefix)})&&new URL(a.href).pathname.endsWith('/index.html'))`,
    ),
  );
  const heading = await doc.evaluate('document.querySelector("#search-results h2").textContent');
  await doc.evaluate('document.querySelector("#search-results a").click()');
  doc = await content(heading);
  assert.equal(await doc.evaluate("document.documentElement.dataset.theme"), "dark");
  await doc.evaluate(`location.href=${JSON.stringify(`${prefix}index.html?theme=dark`)}`);
  doc = await content("See the work.");
  assert.equal(
    await doc.evaluate('document.querySelectorAll(".workspace-example iframe").length'),
    0,
  );
  await doc.evaluate('document.querySelector(".workspace-fallback").click()');
  doc = await content("Start something good.");
  await eventually(
    () => doc.evaluate('!!document.querySelector("[data-compare-comment]")'),
    "opaque real React workspace",
  );
  assert.equal(await doc.evaluate('document.documentElement.classList.contains("dark")'), true);
  await doc.evaluate('document.querySelector("[data-compare-comment]").click()');
  await eventually(
    () =>
      doc.evaluate(
        'document.querySelectorAll("[data-artifact-comparison] .fieldwork-document").length===2',
      ),
    "opaque comparison",
  );
  await doc.evaluate(`document.querySelector('[aria-label="Return to artifact"]').click()`);
  await doc.evaluate('document.querySelector("[data-discussions-action=comment]").click()');
  await eventually(
    () => doc.evaluate('!!document.querySelector("textarea[aria-label=Comment]")'),
    "opaque composer",
  );
  await doc.evaluate('document.querySelector("textarea[aria-label=Comment]").focus()');
  await doc.command("Input.insertText", { text: "A comment from the opaque artifact preview." });
  await doc.evaluate(
    'document.querySelector("textarea[aria-label=Comment]").form.querySelector("button[type=submit]").click()',
  );
  await eventually(
    () =>
      doc.evaluate(
        'document.querySelector("[data-discussions-list]").textContent.includes("A comment from the opaque artifact preview.")',
      ),
    "opaque local mutation",
  );
  await doc.evaluate('document.querySelector(".example-actions a").click()');
  doc = await content("See the work.");
  assert(requests.every((p) => p.startsWith(prefix)));
  assert.deepEqual(exceptions, []);
  console.log(
    "Artifact sandbox checks passed: relative pages/assets, theme, search, and real React page comparison/commenting inside an opaque preview.",
  );
} catch (e) {
  console.log("requests", requests);
  console.log("targets", await browser.send("Target.getTargets"));
  throw e;
} finally {
  await browser.close();
  server.stop(true);
}
