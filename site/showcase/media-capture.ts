import { eventually, type openTestBrowser } from "../../scripts/browser.ts";

type Browser = Awaited<ReturnType<typeof openTestBrowser>>;
type Page = Awaited<ReturnType<Browser["attach"]>>;

export async function prepareMediaCapture(page: Page, video: boolean, comparison = false) {
  const path = video ? "launch.webm" : "launch.png";
  const kind = video ? "video" : "image";
  await eventually(
    () =>
      page.evaluate(`!!document.querySelector('[data-artifact-thread="thread_launch_${kind}"]') &&
    ${video ? "document.querySelector('video')?.readyState >= 2" : "document.querySelector('[data-media-frame] img')?.naturalWidth > 0"}`),
    "native media and its review thread",
  );
  await page.evaluate(`document.querySelector('[title="Hide files"]')?.click()`);
  await page.evaluate(
    `document.querySelector('[data-file="${video ? "launch.png" : "launch.webm"}"] button[title="Collapse"]')?.click()`,
  );
  await page.evaluate("Promise.all(document.getAnimations().map(animation => animation.finished))");
  await page.evaluate(
    `document.querySelector('[data-artifact-thread="thread_launch_${kind}"] button[title^="Version 1"]')?.click()`,
  );
  await eventually(
    () =>
      page.evaluate(
        `!!document.querySelector('[data-file="${path}"] img[alt="Saved frame"]')?.naturalWidth`,
      ),
    "saved media target displayed",
  );
  if (comparison) {
    await page.evaluate(
      `document.querySelector('[data-compare-comment="comment_launch_${kind}_fix"]').click()`,
    );
    await eventually(
      () =>
        page.evaluate(
          "document.querySelectorAll('[data-artifact-comparison] img').length >= 2 && [...document.querySelectorAll('[data-artifact-comparison] img')].every(img => img.naturalWidth > 0)",
        ),
      "original and revised saved frames",
    );
  }
  await page.evaluate(
    `document.querySelector('[data-artifact-thread="thread_launch_${kind}"]').scrollIntoView({block:'start',behavior:'instant'})`,
  );
  await page.evaluate("Promise.all(document.getAnimations().map(animation => animation.finished))");
}
