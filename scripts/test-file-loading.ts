import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplicationResponse, loadApplicationAssets } from "../server/application-assets.ts";
import { createArtifactApi } from "../server/artifact-api.ts";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import { PREVIEW_PREFIX } from "../server/preview-contexts.ts";
import { PreviewHost } from "../server/preview-host.ts";
import { previewSupport } from "../server/preview-support.ts";
import { eventually, openTestBrowser } from "./browser.ts";

// Production workspace, synthetic publications, controlled slow image responses,
// and a disposable browser. No normal daemon, user profile, or external network.
const root = await mkdtemp(join(tmpdir(), "r3-file-loading-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const assets = await loadApplicationAssets({ index: join(import.meta.dir, "../web/index.html") });
const preview = new PreviewHost(storage.artifacts, previewSupport);
const api = createArtifactApi(
  storage,
  {
    token: randomBytes(32).toString("base64url"),
    requireLogin: false,
    disableLoginNotice: true,
    version: "file-loading-acceptance",
    allowedHost: (host) => host === "localhost",
  },
  { previews: preview },
);
const application = createApplicationResponse(assets, (request) => api.bootstrap(request));
const imageRequests: string[] = [];
let imageHold: Promise<void> | undefined;
let releaseImages = () => {};
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.endsWith("/resource")) {
      imageRequests.push(url.searchParams.get("path")!);
      await imageHold;
    }
    if (url.pathname.startsWith(PREVIEW_PREFIX)) return preview.fetch(request);
    if (url.pathname.startsWith("/api/")) return api.app.fetch(request);
    return application(request);
  },
});
let browser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
try {
  browser = await openTestBrowser();
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const base64 = await page.evaluate<string>(`(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 1000; canvas.height = 900;
    const ctx = canvas.getContext('2d');
    const gradient = ctx.createLinearGradient(0, 0, 1000, 900);
    gradient.addColorStop(0, '#6045d0'); gradient.addColorStop(1, '#00a9a0');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 1000, 900);
    return canvas.toDataURL('image/png').split(',')[1];
  })()`);
  // Compatibility consent is confined to this synthetic, script-free fixture.
  await page.command("Page.addScriptToEvaluateOnNewDocument", {
    source: "localStorage.setItem('r3:preview-compatibility:v1', 'accepted')",
  });
  const actor = { role: "human", sessionId: null } as const;
  const artifact = storage.artifacts.create({ kind: "files", actor, title: "File loading" });
  await storage.artifacts.publish(artifact.id, {
    actor,
    expectedSeq: 0,
    publicationKey: "fixture",
    content: {
      kind: "files",
      files: [
        ...Array.from({ length: 56 }, (_, index) => ({
          path: `images/${String(index).padStart(2, "0")}.png`,
          mediaType: "image/png",
          base64,
        })),
        {
          path: "README.md",
          mediaType: "text/markdown",
          base64: Buffer.from(
            `# Reading fixture\n\n${"Published paragraph.\n\n".repeat(100)}`,
          ).toString("base64"),
        },
        {
          path: "z-later.md",
          mediaType: "text/markdown",
          base64: Buffer.from(
            `# Later document\n\n${"Unopened paragraph.\n\n".repeat(100)}`,
          ).toString("base64"),
        },
      ],
    },
  });
  const base = `http://localhost:${app.port}/${artifact.id}?version=1`;
  const failures: string[] = [];
  imageHold = new Promise((resolve) => {
    releaseImages = resolve;
  });
  await page.command("Page.navigate", { url: base });
  await eventually(async () => imageRequests.length > 0, "first visible image requested");
  await Bun.sleep(400);
  console.log(`Images requested while visible bytes are held: ${imageRequests.length}`);
  if (imageRequests.length > 2) failures.push("offscreen images compete with the visible images");
  releaseImages();
  imageHold = undefined;
  await eventually(
    () => page.evaluate("document.querySelector('[data-native-media] img')?.naturalWidth === 1000"),
    "visible image decodes",
  );
  await eventually(
    () => page.evaluate("!!document.querySelector('button[title=\"README.md\"]')"),
    "Markdown file navigation",
  );
  await page.evaluate("document.querySelector('button[title=\"README.md\"]').click()");
  await eventually(
    () =>
      page.evaluate(`(() => {
        const file = document.querySelector('[data-file="README.md"]');
        return file?.querySelector('iframe[aria-hidden="false"]') &&
          file.getBoundingClientRect().height > 2000;
      })()`),
    "distant Markdown ready",
  );
  // Let the explicit file jump settle before saving a reading offset.
  await Bun.sleep(200);
  await page.evaluate(`(() => {
    const pane = document.querySelector('[data-artifact-content]');
    const file = pane.querySelector('[data-file="README.md"]');
    pane.scrollTop += file.getBoundingClientRect().top - pane.getBoundingClientRect().top + 1200;
  })()`);
  const key = JSON.stringify([artifact.id, 1, "README.md", "rendered"]);
  await eventually(
    () =>
      page.evaluate(`JSON.parse(sessionStorage.getItem('r3-reading-positions-1') || '[]')
        .some(([key, point]) => key === ${JSON.stringify(key)} && point.y > 1000)`),
    "reading position persisted",
  );
  await page.command("Page.navigate", { url: "about:blank" });
  imageRequests.length = 0;
  await page.command("Page.navigate", { url: base });
  try {
    await eventually(
      () =>
        page.evaluate(`(() => {
          const pane = document.querySelector('[data-artifact-content]');
          const file = pane?.querySelector('[data-file="README.md"]');
          return file && Math.abs(file.getBoundingClientRect().top - pane.getBoundingClientRect().top + 1200) < 2;
        })()`),
      "file-relative reading position restored",
    );
  } catch {
    failures.push("reopening a later file does not restore its reading position");
  }
  console.log(`Images requested while restoring Markdown: ${imageRequests.length}`);
  if (imageRequests.length > 2) failures.push("reading restoration downloads preceding images");
  assert.equal(
    await page.evaluate("document.querySelectorAll('iframe[aria-hidden=\"false\"]').length"),
    1,
    "deep offsets must not initialize following documents while the saved file is loading",
  );

  // Absolute offsets written by older versions reopen the selected file without
  // replaying the old prefix-loading behavior.
  await page.command("Page.navigate", { url: "about:blank" });
  const legacy = await page.command("Page.addScriptToEvaluateOnNewDocument", {
    source: `sessionStorage.setItem('r3-reading-positions-1', ${JSON.stringify(
      JSON.stringify([[key, { x: 0, y: 16000 }]]),
    )})`,
  });
  imageRequests.length = 0;
  await page.command("Page.navigate", { url: base });
  await page.command("Page.removeScriptToEvaluateOnNewDocument", { identifier: legacy.identifier });
  await eventually(
    () =>
      page.evaluate(`(() => {
        const pane = document.querySelector('[data-artifact-content]');
        const file = pane?.querySelector('[data-file="README.md"]');
        return file && Math.abs(file.getBoundingClientRect().top - pane.getBoundingClientRect().top) < 2;
      })()`),
    "legacy reading metadata reopens the selected file",
  );
  assert(imageRequests.length <= 2, "legacy offsets must not download the prefix");

  const small = storage.artifacts.create({ kind: "files", actor, title: "Small media stack" });
  await storage.artifacts.publish(small.id, {
    actor,
    expectedSeq: 0,
    publicationKey: "small",
    content: {
      kind: "files",
      files: Array.from({ length: 4 }, (_, index) => ({
        path: `image-${index}.png`,
        mediaType: "image/png",
        base64,
      })),
    },
  });
  await page.command("Page.navigate", { url: "about:blank" });
  imageRequests.length = 0;
  imageHold = new Promise((resolve) => {
    releaseImages = resolve;
  });
  await page.command("Page.navigate", { url: `http://localhost:${app.port}/${small.id}` });
  await eventually(async () => imageRequests.length > 0, "small media stack starts loading");
  await Bun.sleep(400);
  assert(imageRequests.length <= 2, "small media-only artifacts also defer offscreen images");
  releaseImages();
  imageHold = undefined;
  assert.deepEqual(failures, []);
  console.log("Visible image loading and later-file reading restoration passed");
} finally {
  releaseImages();
  await browser?.close();
  app.stop(true);
  api.close();
  preview.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
