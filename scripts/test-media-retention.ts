import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactApi } from "../server/artifact-api.ts";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import { PREVIEW_PREFIX } from "../server/preview-contexts.ts";
import { PreviewHost } from "../server/preview-host.ts";
import { previewSupport } from "../server/preview-support.ts";
import { eventually } from "./browser.ts";
import { browserLoweredCssPlugin } from "./spa-css.ts";

// Real media, scrolling, and sandboxed previews in a disposable workspace.
// Supply installed Playwright, Chromium, and ffmpeg; no downloads or user daemon.
const playwright = await import(process.env.R3_TEST_PLAYWRIGHT!);
const root = await mkdtemp(join(tmpdir(), "r3-media-retention-"));
const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "preview-workspace-fixture.tsx")],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [await browserLoweredCssPlugin()],
});
if (!build.success) throw new Error("Media workspace fixture build failed");
const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
const js = [...assets.keys()].find((path) => path.endsWith(".js"))!;
const css = [...assets.keys()].find((path) => path.endsWith(".css"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human" as const, sessionId: null };
const fixtures = [];
for (const { kind, path, mediaType } of [
  { kind: "image", path: "clip.svg", mediaType: "image/svg+xml" },
  { kind: "video", path: "clip.webm", mediaType: "video/webm" },
  { kind: "audio", path: "clip.wav", mediaType: "audio/wav" },
] as const) {
  if (kind === "image") {
    await Bun.write(
      join(root, path),
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="blue"/></svg>',
    );
  } else {
    const generate = Bun.spawn(
      [
        process.env.R3_TEST_FFMPEG ?? "ffmpeg",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        kind === "video" ? "color=c=blue:s=160x90:r=10" : "anullsrc=r=8000:cl=mono",
        "-t",
        "40",
        ...(kind === "video" ? ["-c:v", "libvpx", "-b:v", "20k"] : []),
        join(root, path),
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    assert.equal(await generate.exited, 0, "ffmpeg must generate the synthetic media fixture");
  }
  const base64 = Buffer.from(await Bun.file(join(root, path)).arrayBuffer()).toString("base64");
  const artifact = storage.artifacts.create({ kind: "files", actor, title: `${kind} retention` });
  for (const seq of [1, 2]) {
    await storage.artifacts.publish(artifact.id, {
      actor,
      expectedSeq: seq - 1,
      publicationKey: `fixture-${seq}`,
      content: {
        kind: "files",
        files: [
          { path, mediaType, base64 },
          {
            path: "transcript.md",
            mediaType: "text/markdown",
            base64: Buffer.from(
              `# Transcript\n\n${"Published paragraph.\n\n".repeat(100)}`,
            ).toString("base64"),
          },
          { path: `unopened-${path}`, mediaType, base64 },
        ],
      },
    });
  }
  fixtures.push({ id: artifact.id, path, kind });
}
const preview = new PreviewHost(storage.artifacts, undefined, previewSupport);
const resourceRequests = new Map<string, number>();
const api = createArtifactApi(
  storage,
  {
    token: randomBytes(32).toString("base64url"),
    requireLogin: false,
    version: "media-acceptance",
    allowedHost: (host) => host === "localhost",
  },
  { previews: preview },
);
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith(PREVIEW_PREFIX)) {
      const file = path.split("/files/")[1];
      if (file) resourceRequests.set(file, (resourceRequests.get(file) ?? 0) + 1);
      return preview.fetch(request);
    }
    if (path.startsWith("/api/")) return api.app.fetch(request);
    const asset = assets.get(path.slice(1));
    if (asset) return new Response(asset);
    return new Response(
      `<!doctype html><html><head>${css ? `<link rel="stylesheet" href="/${css}">` : ""}<style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style></head><body><div id="root"></div><script type="module" src="/${js}"></script></body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
const browser = await playwright.chromium.launch({
  headless: true,
  executablePath: process.env.R3_TEST_BROWSER,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  for (const fixture of fixtures) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(
      `http://localhost:${app.port}/${fixture.id}?version=1&file=${fixture.path}&view=rendered`,
    );
    if (process.env.R3_TEST_UNSUPPORTED === "1")
      await page.getByRole("button", { name: "Accept risk and continue" }).click();
    const card = page.locator(`[data-file="${fixture.path}"]`);
    const mediaElement = () =>
      card
        .frameLocator('iframe[aria-hidden="false"]')
        .locator(fixture.kind === "image" ? "img" : fixture.kind);
    await mediaElement().waitFor();
    assert.equal(
      await page.locator(`[data-file="unopened-${fixture.path}"] iframe`).count(),
      0,
      "offscreen media must remain unloaded until first opened",
    );
    const originalFrame = await card.locator('iframe[aria-hidden="false"]').elementHandle();
    if (fixture.kind === "image") {
      await mediaElement().evaluate((image: HTMLImageElement) => image.decode());
    } else {
      await mediaElement().evaluate(async (media: HTMLMediaElement) => {
        media.muted = true;
        await media.play();
        media.currentTime = 5;
      });
    }
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
    if (fixture.kind === "video") {
      for (const [name, width, height] of [
        ["wide", 1920, 900],
        ["phone", 390, 844],
        ["desktop", 1440, 900],
      ] as const) {
        await page.setViewportSize({ width, height });
        const layout = await eventually(async () => {
          const box = await mediaElement().evaluate((video: HTMLVideoElement) => {
            const rect = video.getBoundingClientRect();
            return {
              width: rect.width,
              height: rect.height,
              frameWidth: innerWidth,
              frameHeight: innerHeight,
              ratio: video.videoWidth / video.videoHeight,
              overflow: document.documentElement.scrollHeight - innerHeight,
            };
          });
          const previewBox = await card.locator("[data-artifact-preview]").boundingBox();
          return (
            Math.abs(box.width - box.frameWidth) <= 1 &&
            Math.abs(box.height - box.width / box.ratio) <= 1 &&
            Math.abs(box.height - box.frameHeight) <= 1 &&
            box.overflow <= 1 &&
            previewBox &&
            Math.abs(previewBox.height - box.height) <= 1 &&
            box
          );
        }, "full-width video and fitted frame without cropping, inner scrolling, or empty space");
        console.log(`${name} video layout: ${layout.width} × ${layout.height}`);
        if (process.env.R3_TEST_SCREENSHOTS)
          await page.screenshot({
            path: join(process.env.R3_TEST_SCREENSHOTS, `media-video-${name}.png`),
          });
      }
    }
    const before =
      fixture.kind === "image"
        ? 0
        : await mediaElement().evaluate((media: HTMLMediaElement) => media.currentTime);
    const requestsBefore = resourceRequests.get(fixture.path);
    const pane = page.locator("[data-artifact-content]");
    await pane.evaluate((el: HTMLElement) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(400);
    const mountedOffscreen = await card.locator('iframe[aria-hidden="false"]').count();
    const offscreenTime =
      mountedOffscreen && fixture.kind !== "image"
        ? await mediaElement().evaluate((media: HTMLMediaElement) => media.currentTime)
        : 0;
    await pane.evaluate((el: HTMLElement) => {
      el.scrollTop = 0;
    });
    await mediaElement().waitFor();
    assert.equal(mountedOffscreen, 1, "the same media preview must remain mounted offscreen");
    assert(await originalFrame.evaluate((frame: HTMLIFrameElement) => frame.isConnected));
    if (fixture.kind === "image") {
      await mediaElement().evaluate((image: HTMLImageElement) => image.decode());
      assert.equal(
        await mediaElement().evaluate((image: HTMLImageElement) => image.naturalWidth),
        160,
      );
      assert.equal(
        resourceRequests.get(fixture.path),
        requestsBefore,
        "scrolling must not reload image bytes",
      );
      console.log("image: retained the loaded preview without refetching bytes");
    } else {
      const after = await mediaElement().evaluate((media: HTMLMediaElement) => ({
        time: media.currentTime,
        paused: media.paused,
      }));
      console.log(
        `${fixture.kind}: before=${before.toFixed(2)}, after=${after.time.toFixed(2)}, paused=${after.paused}, mountedOffscreen=${mountedOffscreen}`,
      );
      assert(after.time >= before, "scrolling away and back must not reset media progress");
      assert.equal(after.paused, false, "scrolling must not interrupt playback");
      assert(offscreenTime > before, "playback must advance while offscreen");

      const pausedAt = await mediaElement().evaluate((media: HTMLMediaElement) => {
        media.pause();
        media.volume = 0.3;
        media.playbackRate = 1.5;
        return media.currentTime;
      });
      await pane.evaluate((el: HTMLElement) => {
        el.scrollTop = el.scrollHeight;
      });
      await page.waitForTimeout(400);
      await pane.evaluate((el: HTMLElement) => {
        el.scrollTop = 0;
      });
      assert.deepEqual(
        await mediaElement().evaluate((media: HTMLMediaElement) => ({
          time: media.currentTime,
          paused: media.paused,
          volume: media.volume,
          rate: media.playbackRate,
        })),
        { time: pausedAt, paused: true, volume: 0.3, rate: 1.5 },
      );
    }

    await page.getByRole("button", { name: "Go to the latest version", exact: true }).click();
    await page.waitForFunction((frame: HTMLIFrameElement) => !frame.isConnected, originalFrame);
    await mediaElement().waitFor();
    if (fixture.kind !== "image")
      assert.equal(
        await mediaElement().evaluate((media: HTMLMediaElement) => media.currentTime),
        0,
        "a different publication must have its own player state",
      );
    await card.getByRole("button", { name: "Collapse", exact: true }).click();
    await card.locator("iframe").waitFor({ state: "detached" });
    console.log(`${fixture.kind}: lazy loading, version replacement, and collapse cleanup passed`);
    await context.close();
  }
} finally {
  await browser.close();
  app.stop(true);
  api.close();
  preview.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
