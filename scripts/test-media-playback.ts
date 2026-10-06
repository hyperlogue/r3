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
import { browserLoweredCssPlugin } from "./spa-css.ts";

// Real media, scrolling, and sandboxed previews in a disposable workspace.
// Supply installed Playwright, Chromium, and ffmpeg; no downloads or user daemon.
const playwright = await import(process.env.R3_TEST_PLAYWRIGHT!);
const root = await mkdtemp(join(tmpdir(), "r3-media-playback-"));
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
for (const kind of ["video", "audio"] as const) {
  const path = kind === "video" ? "clip.webm" : "clip.wav";
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
  const artifact = storage.artifacts.create({ kind: "files", actor, title: `${kind} playback` });
  for (const seq of [1, 2]) {
    await storage.artifacts.publish(artifact.id, {
      actor,
      expectedSeq: seq - 1,
      publicationKey: `fixture-${seq}`,
      content: {
        kind: "files",
        files: [
          {
            path,
            mediaType: kind === "video" ? "video/webm" : "audio/wav",
            base64: Buffer.from(await Bun.file(join(root, path)).arrayBuffer()).toString("base64"),
          },
          {
            path: "transcript.md",
            mediaType: "text/markdown",
            base64: Buffer.from(
              `# Transcript\n\n${"Published paragraph.\n\n".repeat(100)}`,
            ).toString("base64"),
          },
          {
            path: `unopened-${path}`,
            mediaType: kind === "video" ? "video/webm" : "audio/wav",
            base64: Buffer.from(await Bun.file(join(root, path)).arrayBuffer()).toString("base64"),
          },
        ],
      },
    });
  }
  fixtures.push({ id: artifact.id, path, kind });
}
const preview = new PreviewHost(storage.artifacts, undefined, previewSupport);
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
    if (path.startsWith(PREVIEW_PREFIX)) return preview.fetch(request);
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
    const player = () => card.frameLocator('iframe[aria-hidden="false"]').locator(fixture.kind);
    await player().waitFor();
    assert.equal(
      await page.locator(`[data-file="unopened-${fixture.path}"] iframe`).count(),
      0,
      "offscreen media must remain unloaded until first opened",
    );
    const originalFrame = await card.locator('iframe[aria-hidden="false"]').elementHandle();
    await player().evaluate(async (media: HTMLMediaElement) => {
      media.muted = true;
      await media.play();
      media.currentTime = 5;
    });
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'));
    const before = await player().evaluate((media: HTMLMediaElement) => media.currentTime);
    const pane = page.locator("[data-artifact-content]");
    await pane.evaluate((el: HTMLElement) => {
      el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(400);
    const mountedOffscreen = await card.locator('iframe[aria-hidden="false"]').count();
    const offscreenTime = mountedOffscreen
      ? await player().evaluate((media: HTMLMediaElement) => media.currentTime)
      : 0;
    await pane.evaluate((el: HTMLElement) => {
      el.scrollTop = 0;
    });
    await player().waitFor();
    const after = await player().evaluate((media: HTMLMediaElement) => ({
      time: media.currentTime,
      paused: media.paused,
    }));
    console.log(
      `${fixture.kind}: before=${before.toFixed(2)}, after=${after.time.toFixed(2)}, paused=${after.paused}, mountedOffscreen=${mountedOffscreen}`,
    );
    assert(after.time >= before, "scrolling away and back must not reset media progress");
    assert.equal(after.paused, false, "scrolling must not interrupt playback");
    assert.equal(mountedOffscreen, 1, "the same media preview must remain mounted offscreen");
    assert(offscreenTime > before, "playback must advance while offscreen");
    assert(await originalFrame.evaluate((frame: HTMLIFrameElement) => frame.isConnected));

    const pausedAt = await player().evaluate((media: HTMLMediaElement) => {
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
      await player().evaluate((media: HTMLMediaElement) => ({
        time: media.currentTime,
        paused: media.paused,
        volume: media.volume,
        rate: media.playbackRate,
      })),
      { time: pausedAt, paused: true, volume: 0.3, rate: 1.5 },
    );

    await page.getByRole("button", { name: "Go to the latest version", exact: true }).click();
    await page.waitForFunction((frame: HTMLIFrameElement) => !frame.isConnected, originalFrame);
    await player().waitFor();
    assert.equal(
      await player().evaluate((media: HTMLMediaElement) => media.currentTime),
      0,
      "a different publication must have its own player state",
    );
    await card.getByRole("button", { name: "Collapse", exact: true }).click();
    await card.locator("iframe").waitFor({ state: "detached" });
    console.log(
      `${fixture.kind}: paused state, lazy loading, version replacement, and collapse cleanup passed`,
    );
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
