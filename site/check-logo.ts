import assert from "node:assert/strict";
import { eventually, type openTestBrowser } from "../scripts/browser.ts";

type Browser = Awaited<ReturnType<typeof openTestBrowser>>;
type Page = Awaited<ReturnType<Browser["attach"]>>;

export async function checkLogo(page: Pick<Page, "evaluate">, reduced = false) {
  await eventually(
    () => page.evaluate("!!document.querySelector('.site-logo-button .arms')"),
    "shared logo SVG loads from the current site mount",
  );
  const url = await page.evaluate("location.href");
  assert.equal(
    await page.evaluate(
      "document.querySelector('.site-logo-mark .arms').hasAttribute('transform')",
    ),
    false,
    "the logo waits for a click",
  );
  await page.evaluate("document.querySelector('.site-logo-button').click()");
  if (reduced) {
    await page.evaluate(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    assert.equal(
      await page.evaluate(
        "document.querySelector('.site-logo-mark .arms').hasAttribute('transform')",
      ),
      false,
      "reduced motion keeps the mark still",
    );
  } else {
    await eventually(
      () =>
        page.evaluate("document.querySelector('.site-logo-mark .arms').hasAttribute('transform')"),
      "click starts the shared fidget animation",
    );
    await page.evaluate("document.querySelector('.site-logo-button').click()");
    await eventually(
      () =>
        page.evaluate("!document.querySelector('.site-logo-mark .arms').hasAttribute('transform')"),
      "repeated clicks finish upright",
    );
  }
  assert.equal(await page.evaluate("location.href"), url, "playing the logo does not navigate");
}
