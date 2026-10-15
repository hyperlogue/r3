import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { eventually, openTestBrowser } from "../scripts/browser.ts";
import { normalizeBase } from "./render.ts";
import { serveSite } from "./serve.ts";
import { annotationState, clickAnnotation, componentFrames } from "./showcase/browser.ts";
import { verifyWorkspaceFont } from "./showcase/font-check.ts";

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
    await verifyWorkspaceFont(page);
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
  const [component] = await componentFrames(browser, page);
  await verifyWorkspaceFont(component!);
  await component!.evaluate("document.querySelector('#component-action').click()");
  assert(
    await component!.evaluate("!document.querySelector('.component-status').hidden"),
    "authored component action works",
  );
  await page.evaluate(
    "[...document.querySelectorAll('[data-artifact-comment=comment_components_fix] button')].find(button => button.textContent.includes('Fix:')).click()",
  );
  await click('[aria-label="Hide discussion"]');
  await clickAnnotation(component!, "marker");
  await waitFor(
    "!!document.querySelector('[data-artifact-thread-popover]')",
    "existing component thread popover",
  );
  const popover = "[data-artifact-thread-popover]";
  const box = await eventually(async () => {
    const value = await annotationState(component!, "box");
    return value && !value.hidden ? value : null;
  }, "native located highlight");
  const marker = await annotationState(component!, "marker");
  const action = await component!.evaluate(
    "document.querySelector('#component-action').getBoundingClientRect().toJSON()",
  );
  assert.equal(box.radius, "0px", "the actual preview runtime uses a rectangular highlight");
  assert.equal(box.border, "rgb(37, 99, 235)");
  assert.equal(marker.text, "●", "the actual preview runtime uses a dot, not a numbered pin");
  assert.deepEqual(box.rect, action, "the highlight follows the element bounds");
  const boundary = await page.evaluate(
    `({left: document.querySelector('.component-preview').getBoundingClientRect().left, edge:document.querySelector('${popover}').getBoundingClientRect().left})`,
  );
  assert(
    box.rect.right + boundary.left < boundary.edge &&
      marker.rect.right + boundary.left < boundary.edge,
    "native annotations remain unobscured",
  );
  assert.equal(
    await page.evaluate(
      `document.querySelector('${popover}').querySelectorAll('[data-artifact-comment]').length`,
    ),
    1,
  );
  assert.equal(
    await component!.evaluate(
      "getComputedStyle(document.querySelector('#component-action')).marginTop",
    ),
    "16px",
  );
  await click(`${popover} [data-thread-action="comment"]`);
  await waitFor(`!!document.querySelector('${popover} textarea')`, "existing thread reply");
  await page.evaluate(`document.querySelector('${popover} textarea').focus()`);
  await page.command("Input.insertText", {
    text: "Please decrease the margin back to 8px.",
  });
  await waitFor(
    `!document.querySelector('${popover} button[type=submit]').disabled`,
    "component reply ready",
  );
  await screenshot("component-thread-reply.png");
  await click(`${popover} button[type=submit]`);
  await waitFor(`!document.querySelector('${popover} textarea')`, "component reply saved");
  await waitFor(
    `document.querySelector('${popover}').querySelectorAll('[data-artifact-comment]').length === 2`,
    "reply extends the existing thread",
  );
  await click(`${popover} [data-compare-comment="comment_components_fix"]`);
  await waitFor(
    "document.querySelectorAll('[data-artifact-comparison] .component-preview').length === 2",
    "component versions compared",
  );
  const compared = await componentFrames(browser, page, 2);
  assert.deepEqual(
    (
      await Promise.all(
        compared.map((frame) =>
          frame.evaluate("getComputedStyle(document.querySelector('#component-action')).marginTop"),
        ),
      )
    ).sort((a, b) => parseInt(a, 10) - parseInt(b, 10)),
    ["8px", "16px"],
    "the two publications match the spacing conversation",
  );

  // A real annotation gesture selects the element without activating it.
  await page.command("Page.navigate", {
    url: `${server.url.origin}${base}/example/index.html?scene=components&embedded=1`,
  });
  const [picking] = await componentFrames(browser, page);
  await click('[aria-label="Comment mode"]');
  const documentBounds = await page.evaluate(
    "document.querySelector('.component-preview').getBoundingClientRect().toJSON()",
  );
  const buttonBounds = await picking!.evaluate(
    "document.querySelector('#component-action').getBoundingClientRect().toJSON()",
  );
  const point = {
    x: documentBounds.left + buttonBounds.left + 20,
    y: documentBounds.top + buttonBounds.top + buttonBounds.height / 2,
  };
  for (const type of ["mousePressed", "mouseReleased"])
    await page.command("Input.dispatchMouseEvent", {
      type,
      ...point,
      button: "left",
      clickCount: 1,
    });
  await eventually(async () => {
    const value = await annotationState(picking!, "box");
    return value && !value.hidden;
  }, "picked element highlight");
  assert(
    await picking!.evaluate("document.querySelector('.component-status').hidden"),
    "picking does not activate the authored button",
  );
  await clickAnnotation(picking!, "controls");
  await waitFor(
    "!!document.querySelector('[data-artifact-composer] textarea') && document.body.innerText.includes('View activity')",
    "native element target opens the shared composer",
  );
  assert(
    await page.evaluate("document.body.innerText.includes('View activity')"),
    "composer retains the selected element quote",
  );

  // Every prompt links to an actual review, including functional authored content.
  await viewport(1240);
  for (const scene of ["explainer", "brief"]) {
    await page.command("Page.navigate", {
      url: `${server.url.origin}${base}/example/index.html?scene=${scene}&embedded=1`,
    });
    await waitFor(
      "!!document.querySelector('.prompt-document-note') && !!document.querySelector('[data-compare-comment]')",
      `${scene} review`,
    );
    await verifyWorkspaceFont(page);
    if (scene === "explainer") {
      const first = await page.evaluate(
        "document.querySelector('.ranking-results strong').textContent",
      );
      await page.evaluate("document.querySelector('[aria-label=\"Freshness weight\"]').focus()");
      await page.command("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "End",
        code: "End",
        windowsVirtualKeyCode: 35,
      });
      await page.command("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "End",
        code: "End",
        windowsVirtualKeyCode: 35,
      });
      await waitFor(
        "document.querySelector('[aria-label=\"Freshness weight\"]').value === '100'",
        "freshness slider changes",
      );
      assert.notEqual(
        await page.evaluate("document.querySelector('.ranking-results strong').textContent"),
        first,
        "freshness changes the top result",
      );
    }
    await screenshot(`prompt-${scene}.png`);
    await click('[data-compare-comment="comment_fieldwork_fix"]');
    await waitFor(
      "document.querySelectorAll('[data-artifact-comparison] .prompt-document').length === 2",
      `${scene} comparison`,
    );
    assert.equal(
      await page.evaluate(
        "document.querySelectorAll('[data-artifact-comparison] .prompt-document-note').length",
      ),
      1,
      "the explanation belongs to the revised publication",
    );
  }

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
