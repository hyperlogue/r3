import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { eventually, openTestBrowser } from "../scripts/browser.ts";
import { normalizeBase } from "./render.ts";
import { serveSite } from "./serve.ts";

const base = normalizeBase(process.env.R3_SITE_BASE);
const server = serveSite(join(import.meta.dir, "../dist/pages"), { base, port: 0 });
const browser = await openTestBrowser();
const failures: string[] = [];
const requests: string[] = [];
browser.listen((event) => {
  if (event.method === "Runtime.exceptionThrown") failures.push(event.params.exceptionDetails.text);
  if (event.method === "Network.requestWillBeSent") requests.push(event.params.request.url);
});
const images = join(import.meta.dir, "../dist/site-review");
await mkdir(images, { recursive: true });
try {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  await page.command("Network.enable");
  const viewport = (width: number, height = 740) =>
    page.command("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
  const waitFor = (expression: string, description: string) =>
    eventually(() => page.evaluate(expression), description);
  const click = (selector: string) =>
    page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const open = async (theme = "light", embedded = true) => {
    await page.command("Page.navigate", {
      url: `${server.url.origin}${base}/example/index.html?theme=${theme}${embedded ? "&embedded=1" : ""}`,
    });
    await waitFor(
      "!!document.querySelector('[data-artifact-thread]') && !!document.querySelector('.fieldwork-help')",
      "real workspace and latest revision",
    );
    await page.evaluate("document.fonts.ready");
    assert(
      !(await page.evaluate("document.body.innerText.includes('Go to the latest version')")),
      "the initial scene already shows the latest publication",
    );
  };
  const screenshot = async (name: string) => {
    await page.evaluate(
      "Promise.all(document.getAnimations().map(animation => animation.finished))",
    );
    const { data } = await page.command("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(images, name), Buffer.from(data, "base64"));
  };
  await viewport(1200);
  await open();
  assert(
    await page.evaluate("!document.querySelector('.example-banner')"),
    "embedded workspace omits the sample header",
  );
  await screenshot("fieldwork-light.png");
  await open("dark");
  await screenshot("fieldwork-dark.png");

  // This is the real comparison UI; both copies use the supplied renderer.
  await click('[data-compare-comment="comment_fieldwork_fix"]');
  await waitFor(
    "document.querySelectorAll('[data-artifact-comparison] .fieldwork-document').length === 2",
    "original / proposed fix comparison",
  );
  assert(
    await page.evaluate(
      "document.body.innerText.includes('Everyone in your workspace can find and open this project.')",
    ),
  );
  await screenshot("fieldwork-comparison.png");
  await open("light", false);

  // The host changes its immutable detail snapshot when fake mutations finish.
  await click('[data-thread-action="resolve"]');
  await waitFor(
    "[...document.querySelectorAll('[role=tab]')].some(el => el.textContent.includes('Resolved 1'))",
    "resolve through injected action",
  );
  await page.evaluate(
    "[...document.querySelectorAll('[role=tab]')].find(el=>el.textContent.includes('Resolved')).click()",
  );
  await waitFor(
    "!!document.querySelector('[data-discussion-queue=resolved] [data-artifact-thread]')",
    "resolved queue",
  );
  await page.evaluate("document.querySelector('.example-banner button').click()");
  await waitFor(
    "!!document.querySelector('[data-discussion-queue=active] [data-artifact-thread]')",
    "reset fixture",
  );
  await click('[data-thread-action="comment"]');
  await waitFor("!!document.querySelector('textarea[aria-label=Reply]')", "real comment composer");
  await page.evaluate("document.querySelector('textarea[aria-label=Reply]').focus()");
  await page.command("Input.insertText", { text: "The visibility explanation is clear now." });
  await page.evaluate(
    "document.querySelector('textarea[aria-label=Reply]').form.querySelector('button[type=submit]').click()",
  );
  await waitFor(
    "document.querySelector('[data-discussion-list]').textContent.includes('The visibility explanation is clear now.')",
    "comment through injected handler",
  );
  await page.evaluate(
    "[...document.querySelectorAll('button')].find(button => button.textContent.startsWith('Send to agent') && !button.disabled).click()",
  );
  await waitFor(
    "document.body.innerText.includes('This is a scripted demo comment.')",
    "scripted agent response",
  );

  // The hero uses the same workspace with a separate component-review fixture.
  await page.command("Page.navigate", {
    url: `${server.url.origin}${base}/example/index.html?theme=light&embedded=1&scene=components`,
  });
  await waitFor("!!document.querySelector('#component-action')", "component showcase");
  await click("#component-action");
  await waitFor("document.body.innerText.includes('You’re all caught up.')", "component action");
  await click('[aria-label="Hide discussion"]');
  await click('[aria-label="Comment mode"]');
  await click("#component-action");
  await waitFor(
    "!!document.querySelector('[data-floating-composer] textarea')",
    "component floating composer",
  );
  await page.evaluate("document.querySelector('[data-floating-composer] textarea').focus()");
  await page.command("Input.insertText", {
    text: "Increase the margin above this button to 16px.",
  });
  await waitFor(
    "!document.querySelector('[data-floating-composer] button[type=submit]').disabled",
    "component draft ready",
  );
  await click("[data-floating-composer] button[type=submit]");
  await waitFor("!document.querySelector('[data-floating-composer]')", "component comment saved");
  await click('[aria-label="Exit comment mode"]');
  await click('[aria-label="Show discussion"]');
  await waitFor(
    "document.querySelector('[data-artifact-thread]')?.textContent.includes('Increase the margin above this button to 16px.')",
    "component comment in discussion",
  );
  await page.evaluate("document.querySelector('[data-artifact-thread] button[title]').click()");
  await waitFor(
    "document.querySelector('#component-action').classList.contains('component-selected')",
    "locate saved component target",
  );

  await viewport(390, 844);
  await open();
  assert(
    await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
    "mobile fits viewport",
  );
  await waitFor("!!document.querySelector('[data-artifact-thread]')", "shared mobile thread UI");
  await screenshot("fieldwork-mobile.png");
  assert.deepEqual(failures, [], "no browser exceptions");
  assert.deepEqual(
    requests.filter((value) => {
      const url = new URL(value);
      return (
        /^https?:$/.test(url.protocol) &&
        (url.origin !== server.url.origin || /\/api\//.test(url.pathname))
      );
    }),
    [],
    "standalone UI never calls a backend or external service",
  );
  console.log(
    "Real ArtifactPage: comparison, resolution, comments, scripted handoff, reset, themes, and mobile pass without backend requests.",
  );
} finally {
  await browser.close();
  server.stop(true);
}
