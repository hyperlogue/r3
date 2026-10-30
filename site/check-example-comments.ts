import assert from "node:assert/strict";
import { join } from "node:path";
import { eventually, openTestBrowser } from "../scripts/browser.ts";
import { normalizeBase } from "./render.ts";
import { serveSite } from "./serve.ts";
import { annotationState, clickAnnotation, componentFrames } from "./showcase/browser.ts";

const base = normalizeBase(process.env.R3_SITE_BASE);
const server = serveSite(join(import.meta.dir, "../dist/pages"), { base, port: 0 });
const browser = await openTestBrowser();
const failures: string[] = [];
browser.listen((event) => {
  if (event.method === "Runtime.exceptionThrown") failures.push(event.params.exceptionDetails.text);
});
try {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 1240,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const click = (selector: string) =>
    page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const wait = (expression: string, label: string) =>
    eventually(() => page.evaluate(expression), label);
  const pointer = (type: string, x: number, y: number) =>
    page.command("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: "left",
      clickCount: 1,
      ...(type === "mouseMoved" ? { buttons: 1 } : {}),
    });
  const save = async (body: string) => {
    await wait(
      "!!document.querySelector('textarea[aria-label=Comment]')",
      "native comment composer",
    );
    await page.evaluate("document.querySelector('textarea[aria-label=Comment]').focus()");
    await page.command("Input.insertText", { text: body });
    await page.evaluate(
      "document.querySelector('textarea[aria-label=Comment]').form.requestSubmit()",
    );
    return wait(
      `Array.from(document.querySelectorAll('[data-artifact-thread]')).find(card => card.textContent.includes(${JSON.stringify(body)}))?.dataset.artifactThread`,
      "saved native thread",
    );
  };
  for (const [scene, selector, quote] of [
    ["prototype", ".fieldwork-create", "Create project"],
    ["explainer", "h1", "What rises to the top?"],
    ["brief", "h1", "Project visibility & access"],
  ]) {
    await page.command("Page.navigate", {
      url: `${server.url.origin}${base}/example/index.html?scene=${scene}&embedded=1`,
    });
    await wait("!!document.querySelector('[aria-label=\"Comment mode\"]')", "example comment mode");
    // Retain the inline path so this assertion catches the original bug too.
    const framed = await page.evaluate("!!document.querySelector('iframe')");
    const doc = framed ? (await componentFrames(browser, page, 1, selector))[0]! : page;
    await eventually(
      () => doc.evaluate(`!!document.querySelector(${JSON.stringify(selector)})`),
      "authored content",
    );
    await click('[aria-label="Comment mode"]');
    const bounds = await doc.evaluate(
      `document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().toJSON()`,
    );
    const offset = framed
      ? await page.evaluate("document.querySelector('iframe').getBoundingClientRect().toJSON()")
      : { left: 0, top: 0 };
    for (const type of ["mousePressed", "mouseReleased"])
      await pointer(
        type,
        offset.left + bounds.left + 20,
        offset.top + bounds.top + bounds.height / 2,
      );
    if (scene === "prototype")
      assert.equal(
        await doc.evaluate("!!document.querySelector('[role=status]')"),
        false,
        "comment mode must pick the Create project button without submitting its form",
      );
    await eventually(async () => {
      const box = await annotationState(doc, "box");
      return box && !box.hidden;
    }, "native picked element highlight");
    await clickAnnotation(doc, "controls");
    await wait(
      `document.querySelector('[data-artifact-composer]')?.textContent.includes(${JSON.stringify(quote)})`,
      "composer retains the chosen element",
    );
    const thread = await save(`Please revise this ${scene} element.`);
    await click('[aria-label="Exit comment mode"]');
    // Locate must resolve the saved target, rather than a preselected fixture area.
    await click(`[data-artifact-thread="${thread}"] button[title]`);
    const located = await eventually(
      () =>
        doc.evaluate(
          "[...(CSS.highlights.get('r3-preview-active') ?? [])].map(range => range.toString()).join('')",
        ),
      "saved target located",
    );
    assert(located.includes(quote), "Locate highlights the actual saved quote");
    if (scene !== "prototype") continue;

    // Normal reading retains authored controls, and selecting arbitrary text
    // creates a native quote target without turning comment mode back on.
    const normal = await doc.evaluate(
      "document.querySelector('.fieldwork-create').getBoundingClientRect().toJSON()",
    );
    for (const type of ["mousePressed", "mouseReleased"])
      await pointer(
        type,
        offset.left + normal.left + 20,
        offset.top + normal.top + normal.height / 2,
      );
    await eventually(
      () => doc.evaluate("!!document.querySelector('[role=status]')"),
      "normal form submission",
    );
    await doc.evaluate(
      "document.querySelector('.fieldwork-intro').scrollIntoView({block:'center'})",
    );
    const text = await doc.evaluate(`(() => {
      const range = document.createRange(); range.selectNodeContents(document.querySelector('.fieldwork-intro'));
      return range.getBoundingClientRect().toJSON();
    })()`);
    await pointer(
      "mousePressed",
      offset.left + text.left + 1,
      offset.top + text.top + text.height / 2,
    );
    await pointer(
      "mouseMoved",
      offset.left + text.right - 1,
      offset.top + text.top + text.height / 2,
    );
    await pointer(
      "mouseReleased",
      offset.left + text.right - 1,
      offset.top + text.top + text.height / 2,
    );
    await wait(
      "document.querySelector('[data-artifact-composer]')?.textContent.includes('Give your next idea')",
      "native text selection quote",
    );
    await save("Make this introduction more specific.");
  }
  assert.deepEqual(failures, [], "no browser exceptions");
  console.log(
    "Example comments pass: native element picking, saved targets, Locate, text selection, and ordinary form interaction across all three scenes.",
  );
} finally {
  await browser.close();
  server.stop(true);
}
