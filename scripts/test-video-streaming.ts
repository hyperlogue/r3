import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactApi } from "../server/artifact-api.ts";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import { COOKIE_NAME } from "../server/auth.ts";
import { eventually, openTestBrowser } from "./browser.ts";
import { browserLoweredCssPlugin } from "./spa-css.ts";

// Large MP4 playback over a bounded connection, with real cookie authentication.
// Supply installed Chromium and ffmpeg. An optional R3_TEST_VIDEO uses original
// published bytes downloaded separately; never open the normal server database.
const root = await mkdtemp(join(tmpdir(), "r3-video-streaming-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
let app: ReturnType<typeof Bun.serve> | undefined;
let api: ReturnType<typeof createArtifactApi> | undefined;
let browser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
try {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "preview-workspace-fixture.tsx")],
    target: "browser",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [await browserLoweredCssPlugin()],
  });
  assert.ok(build.success, "workspace fixture builds");
  const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
  const js = [...assets.keys()].find((path) => path.endsWith(".js"))!;
  const css = [...assets.keys()].find((path) => path.endsWith(".css"));
  let bytes: Buffer;
  if (process.env.R3_TEST_VIDEO) {
    bytes = Buffer.from(await Bun.file(process.env.R3_TEST_VIDEO).arrayBuffer());
  } else {
    const generated = Bun.spawn(
      [
        process.env.R3_TEST_FFMPEG ?? "ffmpeg",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=640x360:rate=12:duration=20",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=44100:duration=20",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        join(root, "clip.mp4"),
      ],
      { stdout: "ignore", stderr: "inherit" },
    );
    assert.equal(await generated.exited, 0, "generate H.264/AAC MP4");
    const clip = Buffer.from(await Bun.file(join(root, "clip.mp4")).arrayBuffer());
    let moov = 0;
    while (moov < clip.length && clip.toString("ascii", moov + 4, moov + 8) !== "moov") {
      const size = clip.readUInt32BE(moov);
      assert.ok(size >= 8);
      moov += size;
    }
    assert.ok(moov < clip.length, "metadata is after the encoded media");
    // Insert a legal free atom before tail metadata. Existing media chunk offsets
    // remain valid; a streaming player must seek past the padding to the moov atom.
    const padding = Buffer.alloc(24 * 1024 * 1024);
    padding.writeUInt32BE(padding.length);
    padding.write("free", 4);
    bytes = Buffer.concat([clip.subarray(0, moov), padding, clip.subarray(moov)]);
  }
  const actor = { role: "human", sessionId: null } as const;
  const artifact = storage.artifacts.create({ kind: "files", actor, title: "Mobile videos" });
  await storage.artifacts.publish(artifact.id, {
    actor,
    expectedSeq: 0,
    publicationKey: "videos",
    content: {
      kind: "files",
      files: ["first.mp4", "second.mp4"].map((path) => ({
        path,
        mediaType: "video/mp4",
        base64: bytes.toString("base64"),
      })),
    },
  });
  api = createArtifactApi(storage, {
    token: randomBytes(32).toString("base64url"),
    requireLogin: true,
    version: "video-acceptance",
    allowedHost: (host) => host === "localhost",
  });
  const reads: { path: string; range: string | null; status: number }[] = [];
  app = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api/")) {
        const response = await api!.app.fetch(request);
        if (url.pathname.endsWith("/resource"))
          reads.push({
            path: url.searchParams.get("path")!,
            range: request.headers.get("range"),
            status: response.status,
          });
        return response;
      }
      const asset = assets.get(url.pathname.slice(1));
      if (asset) return new Response(asset);
      return new Response(
        `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">${css ? `<link rel="stylesheet" href="/${css}">` : ""}<style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style></head><body><div id="root"></div><script type="module" src="/${js}"></script></body></html>`,
        { headers: { "Content-Type": "text/html" } },
      );
    },
  });
  const origin = `http://localhost:${app.port}`;
  const resource = `${origin}/api/artifacts/${artifact.id}/versions/1/resource?path=first.mp4`;
  assert.equal((await fetch(resource, { headers: { Range: "bytes=0-1023" } })).status, 401);
  browser = await openTestBrowser();
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  await page.command("Network.enable");
  await page.command("Network.setCookie", {
    name: COOKIE_NAME,
    value: storage.authentication.mintLocalSession().cookieValue,
    url: origin,
    httpOnly: true,
    sameSite: "Strict",
  });
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await page.command("Emulation.setTouchEmulationEnabled", { enabled: true });
  await page.command("Network.emulateNetworkConditions", {
    offline: false,
    latency: 40,
    downloadThroughput: 500_000,
    uploadThroughput: 500_000,
  });
  const start = Date.now();
  await page.command("Page.navigate", { url: `${origin}/${artifact.id}?version=1` });
  await eventually(
    () => page.evaluate("!!document.querySelector('[data-file]')"),
    "video file cards",
  );
  const deadline = Date.now() + 5000;
  let ready = false;
  while (Date.now() < deadline) {
    ready = await page.evaluate("document.querySelector('video')?.readyState >= 2");
    if (ready) break;
    await Bun.sleep(50);
  }
  assert.ok(
    ready,
    "large MP4 is playable within five seconds of the workspace, before full download",
  );
  const firstFrameMs = Date.now() - start;
  assert.ok(
    reads.some((read) => read.range && read.status === 206),
    "video uses authenticated range requests",
  );
  assert.ok(!reads.some((read) => read.status === 200), "no whole-video fetch before playback");
  const playButton = await page.evaluate(`(() => {
    const r=document.querySelector('[aria-label="Play video"]').getBoundingClientRect();
    return {x:r.x+r.width/2,y:r.y+r.height/2};
  })()`);
  await page.command("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [playButton] });
  await page.command("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await eventually(
    () => page.evaluate("document.querySelector('video').currentTime > 0.1"),
    "MP4 playback advances",
  );
  await page.evaluate(
    "document.querySelector('video').pause(); document.querySelector('video').currentTime = 12",
  );
  await eventually(
    () =>
      page.evaluate(
        "!document.querySelector('video').seeking && document.querySelector('video').currentTime >= 12",
      ),
    "seek before full download",
  );
  for (const width of [320, 390, 768, 1440]) {
    await page.command("Emulation.setDeviceMetricsOverride", {
      width,
      height: 844,
      deviceScaleFactor: 1,
      mobile: width < 768,
    });
    await Bun.sleep(200);
    const layout = await page.evaluate(`(() => {
      const card = document.querySelector('[data-file="first.mp4"]');
      const media = card.querySelector('[data-native-media]');
      const video = card.querySelector('video');
      return {card:card.getBoundingClientRect().toJSON(),media:media.getBoundingClientRect().toJSON(),video:video.getBoundingClientRect().toJSON(),width:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth};
    })()`);
    assert.ok(
      layout.card.bottom - layout.media.bottom < 2,
      `${width}px has no gap below video controls`,
    );
    assert.ok(layout.video.width <= layout.card.width + 1, `${width}px fits the video width`);
    assert.ok(layout.video.height <= 844 * 0.8 + 1, `${width}px fits the video height`);
    assert.ok(layout.scrollWidth <= layout.width, `${width}px has no horizontal page overflow`);
    if (process.env.R3_TEST_SCREENSHOTS) {
      await mkdir(process.env.R3_TEST_SCREENSHOTS, { recursive: true });
      const shot = await page.command("Page.captureScreenshot", { format: "png" });
      await Bun.write(
        join(process.env.R3_TEST_SCREENSHOTS, `video-${width}.png`),
        Buffer.from(shot.data, "base64"),
      );
    }
  }
  // Native capture stays origin-clean after switching from blob to HTTP media.
  assert.ok(
    await page.evaluate(
      `(() => {const v=document.querySelector('video');const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0);return c.toDataURL('image/png').startsWith('data:image/png;base64,');})()`,
    ),
  );
  await page.evaluate("window.dispatchEvent(new Event('r3-images-cleared'))");
  assert.equal(
    await page.evaluate("document.querySelectorAll('video[src]').length"),
    0,
    "logout clears video sources",
  );
  console.log(
    JSON.stringify({
      firstFrameMs,
      fileBytes: bytes.length,
      rangeRequests: reads.filter((read) => read.status === 206).length,
      widths: [320, 390, 768, 1440],
    }),
  );
} finally {
  await browser?.close();
  app?.stop(true);
  api?.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
