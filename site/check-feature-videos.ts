import assert from "node:assert/strict";
import { eventually, type openTestBrowser } from "../scripts/browser.ts";
import { features } from "./features.ts";

type Browser = Awaited<ReturnType<typeof openTestBrowser>>;
type Page = Awaited<ReturnType<Browser["attach"]>>;

// Run against both the public mount and the opaque artifact document. Loading
// metadata alone does not prove that scoped media can decode or resume a seek.
export async function checkFeatureVideos(page: Pick<Page, "evaluate" | "command">) {
  assert.equal(await page.evaluate("document.querySelectorAll('.feature-video video').length"), 5);
  assert(
    await page.evaluate(
      "!performance.getEntriesByType('resource').some(r => r.name.includes('/assets/videos/') && r.name.endsWith('.mp4'))",
    ),
    "films do not download before playback",
  );
  for (const feature of features) {
    const selector = JSON.stringify(`#${feature.id} video`);
    const video = `document.querySelector(${selector})`;
    assert(
      await page.evaluate(`(() => {
        const v = ${video};
        return v.controls && v.playsInline && v.preload === 'none' && !v.autoplay && v.paused;
      })()`),
      `${feature.id} waits for playback with native controls`,
    );
    await page.evaluate(`new Promise((resolve, reject) => {
      const img = new Image(); img.onload = () => resolve(true); img.onerror = reject;
      img.src = ${video}.poster;
    })`);
    await page.evaluate(
      `${video}.scrollIntoView({block:'center', behavior:'instant'}); ${video}.load()`,
    );
    await eventually(() => page.evaluate(`${video}.readyState >= 2`), `${feature.id} decodes`);
    const metadata = await page.evaluate(`(() => {
      const v = ${video}; return {duration:v.duration, width:v.videoWidth, height:v.videoHeight};
    })()`);
    assert.equal(metadata.duration, feature.duration);
    assert(metadata.duration <= 30);
    assert.equal(metadata.width, 1600);
    assert.equal(metadata.height, 1000);
    for (const fraction of [0.15, 0.55, 0.8]) {
      await page.evaluate(`${video}.currentTime = ${feature.duration * fraction}`);
      await eventually(() => page.evaluate(`!${video}.seeking`), `${feature.id} seeks`);
      const before = await page.evaluate(`${video}.getVideoPlaybackQuality().totalVideoFrames`);
      const result = await page.command("Runtime.evaluate", {
        expression: `${video}.play()`,
        userGesture: true,
        awaitPromise: true,
      });
      assert(!result.exceptionDetails, `${feature.id} plays after user gesture`);
      await eventually(
        () =>
          page.evaluate(
            `${video}.currentTime > ${feature.duration * fraction + 0.2} && ${video}.getVideoPlaybackQuality().totalVideoFrames > ${before}`,
          ),
        `${feature.id} advances decoded frames after seeking`,
      );
      await page.evaluate(`${video}.pause()`);
    }
  }
  await page.evaluate("scrollTo(0,0)");
}
