import assert from "node:assert/strict";
import { eventually, type openTestBrowser } from "../../scripts/browser.ts";
import { clearCaptureFocus, componentFrames } from "./browser.ts";

type Browser = Awaited<ReturnType<typeof openTestBrowser>>;
type Page = Awaited<ReturnType<Browser["attach"]>>;
export async function prepareStoryCapture(
  browser: Browser,
  page: Page,
  scene: "prototype" | "proposal" | "explainer" | "code-review",
  step: "start" | "feedback" | "result",
) {
  const click = (selector: string) =>
    page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const version = step === "result" ? 2 : 1;
  await click('[aria-label="Published version"]');
  await eventually(
    () => page.evaluate(`!!document.querySelector('[data-version-seq="${version}"]')`),
    "version choices",
  );
  await click(`[data-version-seq="${version}"]`);
  await eventually(
    () =>
      page.evaluate(
        `document.querySelector('[aria-label="Published version"]').textContent.includes('v${version}')`,
      ),
    "selected publication",
  );
  if (scene === "proposal") {
    const [frame] = await componentFrames(browser, page, 1, "ol");
    assert(
      await frame!.evaluate(
        `document.querySelector('ol').textContent.includes(${JSON.stringify(version === 1 ? "Invite your teammates" : "Create a project on your own")})`,
      ),
    );
  } else if (scene === "code-review") {
    await eventually(
      () =>
        page.evaluate(
          `document.body.innerText.includes(${JSON.stringify(version === 1 ? "await createProject(values)" : "finally")})`,
        ),
      "published patch lines",
    );
  } else {
    await eventually(
      () =>
        page.evaluate(
          `!!document.querySelector('${scene === "prototype" ? "#visibility" : "#ranking-signals"}')`,
        ),
      "authored example",
    );
  }
  if (step === "start" || (step === "result" && scene === "explainer")) {
    await click('[aria-label="Hide discussion"]');
  }
  if (step === "result" && scene === "explainer") {
    for (const [label, value] of [
      ["Relevance weight", "20"],
      ["Freshness weight", "80"],
    ]) {
      await page.evaluate(
        `(() => { const input = document.querySelector('[aria-label="${label}"]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '${value}'); input.dispatchEvent(new Event('input', {bubbles:true})); })()`,
      );
    }
    await eventually(
      () =>
        page.evaluate(
          "document.querySelector('[aria-label=\"Freshness weight\"]').value === '80' && document.querySelector('.ranking-results').innerText.indexOf('This week') < document.querySelector('.ranking-results').innerText.indexOf('Planning')",
        ),
      "freshness changes ranking",
    );
  }
  if (step === "result" && scene === "prototype") {
    await click('[data-compare-comment="comment_fieldwork_fix"]');
    await eventually(
      () =>
        page.evaluate(
          "document.querySelectorAll('[data-artifact-comparison] .fieldwork-document').length === 2",
        ),
      "original and revised forms",
    );
  }
  if (
    step === "feedback" ||
    (step === "result" && (scene === "proposal" || scene === "code-review"))
  ) {
    const id =
      scene === "proposal" || scene === "code-review" ? "comment_story" : "comment_fieldwork";
    if (step === "feedback") {
      await click("[data-artifact-thread] button[title]");
    } else
      await page.evaluate(
        `(() => { const root = document.querySelector('[data-artifact-comment="${id}_${step === "result" ? "fix" : "question"}"]'); const button = [...(root ?? document).querySelectorAll('button')].find(button => button.textContent.includes('${step === "result" ? "Fix:" : "Original:"}')); button?.click(); })()`,
      );
  }
  await page.evaluate("document.fonts.ready");
  await page.evaluate("new Promise(resolve => setTimeout(resolve, 500))");
  await clearCaptureFocus(page);
}
