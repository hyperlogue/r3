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
import type { ArtifactPreviewContext } from "../shared/artifacts.ts";
import { browserLoweredCssPlugin } from "./spa-css.ts";

// Use a caller-installed Playwright package and browser, with fresh contexts.
// Patched Firefox/WebKit results are engine evidence, never branded Safari evidence.
const packagePath = process.env.R3_TEST_PLAYWRIGHT;
if (!packagePath) throw new Error("Set R3_TEST_PLAYWRIGHT to an installed playwright-core entry");
const playwright = await import(packagePath);
const engine = process.env.R3_TEST_ENGINE ?? "chromium";
if (!["chromium", "firefox", "webkit"].includes(engine)) throw new Error("Unknown test engine");
const unsupported = process.env.R3_TEST_UNSUPPORTED === "1";
const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "preview-workspace-fixture.tsx")],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [await browserLoweredCssPlugin()],
});
if (!build.success) throw new Error("Compatibility fixture build failed");
const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
const js = [...assets.keys()].find((path) => path.endsWith(".js"))!;
const css = [...assets.keys()].find((path) => path.endsWith(".css"));
const root = await mkdtemp(join(tmpdir(), "r3-compatibility-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
let externalRequests = 0;
const outside = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    externalRequests++;
    if (new URL(request.url).pathname === "/document")
      return new Response(
        '<h1>External destination</h1><script>fetch("/after-navigation")</script>',
        {
          headers: { "content-type": "text/html" },
        },
      );
    return new Response("window.externalLoaded=true", {
      headers: { "content-type": "text/javascript", "access-control-allow-origin": "*" },
    });
  },
});
const actor = { role: "human" as const, sessionId: null };
const html = storage.artifacts.create({ kind: "html", actor, title: "Browser compatibility" });
const files = storage.artifacts.create({
  kind: "files",
  actor,
  title: "Rendered file compatibility",
});
const media = storage.artifacts.create({ kind: "files", actor, title: "Several media previews" });
await storage.artifacts.publish(media.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "media",
  content: {
    kind: "files",
    files: [1, 2, 3].map((number) => ({
      path: `image-${number}.svg`,
      mediaType: "image/svg+xml",
      base64: Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="teal"/></svg>',
      ).toString("base64"),
    })),
  },
});
for (const artifact of [html, files]) {
  for (const seq of [1, 2])
    await storage.artifacts.publish(artifact.id, {
      actor,
      expectedSeq: seq - 1,
      publicationKey: `version-${seq}`,
      content: {
        kind: artifact.kind as "html" | "files",
        files: [
          {
            path: "index.html",
            mediaType: "text/html",
            base64:
              Buffer.from(`<!doctype html><html><head><script src="http://localhost:${outside.port}/script.js"></script></head><body>
<h1>Version ${seq}</h1><p id="output">Ready</p><button id="send">Request revision</button><a href="other.html">Other document</a>
<script type="module">import r3 from '/r3/utility.js';window.r3=r3;
document.querySelector('#send').onclick=async()=>{await r3.createFeedback({body:'Compatibility feedback',locator:{selector:'h1',quote:document.querySelector('h1').textContent}});document.querySelector('#output').textContent='Sent'};
window.localData=await fetch('./data.txt').then(r=>r.text());
try {await fetch('http://localhost:${outside.port}/capture');window.fetchBlocked=false}catch{window.fetchBlocked=true}
</script></body></html>`).toString("base64"),
          },
          {
            path: "data.txt",
            mediaType: "text/plain",
            base64: Buffer.from("Published fixture").toString("base64"),
          },
          {
            path: "other.html",
            mediaType: "text/html",
            base64: Buffer.from('<h1>Other document</h1><a href="index.html">Back</a>').toString(
              "base64",
            ),
          },
        ],
      },
    });
}
const preview = new PreviewHost(storage.artifacts, undefined, previewSupport);
const api = createArtifactApi(
  storage,
  {
    token: randomBytes(32).toString("base64url"),
    requireLogin: false,
    version: "acceptance",
    allowedHost: (host) => host === "localhost",
  },
  { previews: preview },
);
const grants: ArtifactPreviewContext[] = [];
let publicationRequests = 0;
let failCheck = false;
let deniedAppRequests = 0;
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith(PREVIEW_PREFIX)) {
      if (path.includes("/files/")) publicationRequests++;
      if (failCheck && path.endsWith("/r3/check"))
        return new Response("Unavailable", { status: 503 });
      return preview.fetch(request);
    }
    if (path.startsWith("/api/")) {
      const response = await api.app.fetch(request);
      if (path.endsWith("/previews") && request.method === "POST" && response.status === 201)
        grants.push((await response.clone().json()) as ArtifactPreviewContext);
      if (request.headers.get("origin") === "null" && response.status === 403) deniedAppRequests++;
      return response;
    }
    const asset = assets.get(path.slice(1));
    if (asset) return new Response(asset);
    return new Response(
      `<!doctype html><html><head>${css ? `<link rel="stylesheet" href="/${css}">` : ""}<style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style></head><body><div id="root"></div><script type="module" src="/${js}"></script></body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
const origin = `http://localhost:${app.port}`;
let browser: any;
try {
  browser = await playwright[engine].launch({
    headless: true,
    ...(process.env.R3_TEST_BROWSER ? { executablePath: process.env.R3_TEST_BROWSER } : {}),
    ...(engine === "chromium" ? { args: ["--no-sandbox", "--disable-dev-shm-usage"] } : {}),
  });
  if (unsupported) {
    const multiple = await browser.newContext();
    const mediaPage = await multiple.newPage();
    const beforeMedia = publicationRequests;
    await mediaPage.goto(`${origin}/?artifact=${media.id}&version=1`);
    await mediaPage.waitForFunction(
      () =>
        document.querySelectorAll('[data-preview-protection="isolation"][data-state="error"]')
          .length === 3,
    );
    assert.equal(
      await mediaPage.locator("[data-preview-compatibility-consent][open]").count(),
      1,
      "concurrent previews show one warning",
    );
    assert.equal(publicationRequests, beforeMedia);
    await mediaPage.getByRole("button", { name: "Keep preview closed" }).click();
    assert.equal(
      await mediaPage.locator("dialog[open]").count(),
      0,
      "one decline closes the warning for all previews",
    );
    assert.equal(await mediaPage.locator("[data-artifact-preview] iframe").count(), 0);
    await mediaPage.getByRole("button", { name: "Review browser risk" }).first().click();
    await mediaPage.getByRole("button", { name: "Accept risk and continue" }).click();
    await mediaPage.waitForFunction(
      () =>
        document.querySelectorAll(
          '[data-preview-network="compatible"] [data-preview-protection="isolation"][data-state="verified"]',
        ).length === 3,
    );
    assert.equal(await mediaPage.locator("dialog[open]").count(), 0);
    await mediaPage.getByRole("button", { name: "Artifact details and actions" }).click();
    assert.equal(
      await mediaPage.getByRole("button", { name: /^Preview security:/ }).count(),
      1,
      "concurrent previews share one security row in the artifact menu",
    );
    assert.equal(
      await mediaPage.locator("[data-preview-security]").getAttribute("data-preview-security"),
      "limited",
    );
    assert.equal(
      await mediaPage.locator("[data-artifact-content] [data-preview-network]").count(),
      0,
    );
    await multiple.close();
  }
  const context = await browser.newContext({ viewport: { width: 1200, height: 850 } });
  const page = await context.newPage();
  const warning = page.locator("[data-preview-compatibility-consent][open]");
  const frame = page.frameLocator("[data-artifact-preview] iframe");
  const waitForContent = async (seq = 1) => {
    await frame.getByRole("heading", { name: `Version ${seq}`, exact: true }).waitFor();
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-preview-protection="isolation"]')
          ?.getAttribute("data-state") === "verified",
    );
  };
  const beforeOpening = publicationRequests;
  await page.goto(`${origin}/?artifact=${html.id}&version=1`);
  if (unsupported) {
    await warning.waitFor();
    assert.equal(publicationRequests, beforeOpening, "no publication bytes before consent");
    assert.equal(
      await page.locator('[data-preview-protection="network"][data-state="verified"]').count(),
      0,
    );
    await warning.getByRole("button", { name: "Keep preview closed" }).click();
    assert.equal(await page.locator("[data-artifact-preview] iframe").count(), 0);
    await page.getByRole("button", { name: "Review browser risk" }).click();
    await warning.getByRole("button", { name: "Accept risk and continue" }).click();
  }
  await waitForContent();
  assert.equal(await warning.count(), 0);
  assert.equal(grants.at(-1)!.network, unsupported ? "compatible" : "blocked");
  const publishedFrame = page
    .frames()
    .find((value: any) => value.url().includes("/files/index.html"))!;
  await publishedFrame.waitForFunction(() => (window as any).fetchBlocked === true);
  assert.equal(await publishedFrame.evaluate(() => (window as any).localData), "Published fixture");
  assert.equal(externalRequests, 0, "compatibility still blocks external fetches and scripts");
  assert.equal(await publishedFrame.evaluate(() => globalThis.origin), "null");
  assert.equal(
    await publishedFrame.evaluate(() => {
      try {
        void parent.document.body;
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  await publishedFrame.evaluate(async (appOrigin: string) => {
    try {
      await fetch(`${appOrigin}/api/artifacts`);
    } catch {}
  }, origin);
  if (unsupported) assert.ok(deniedAppRequests > 0, "real app rejects opaque API requests");
  else
    assert.equal(
      deniedAppRequests,
      0,
      "verified policy blocks unrelated app requests before sending",
    );
  assert.equal(
    await page.locator('[data-preview-protection="network"]').getAttribute("data-state"),
    unsupported ? "limited" : "verified",
  );
  assert.equal(
    await page.locator("[data-preview-camera]").getAttribute("data-preview-camera"),
    "blocked",
  );
  const beforeForgery = grants.length;
  await publishedFrame.evaluate(
    (appOrigin: string) =>
      parent.postMessage(
        {
          type: "r3-preview-gate",
          contextId: location.pathname.split("/")[2],
          state: "unsupported",
          reason: "network",
          message: "Forged failure",
        },
        appOrigin,
      ),
    origin,
  );
  await frame.getByRole("button", { name: "Request revision" }).click();
  await frame.getByText("Sent", { exact: true }).waitFor();
  assert.equal(grants.length, beforeForgery, "publisher cannot forge a downgrade");
  assert.equal(storage.conversations.list(html.id)[0].body, "Compatibility feedback");
  await frame.getByRole("link", { name: "Other document" }).click();
  await frame.getByRole("heading", { name: "Other document" }).waitFor();
  await frame.getByRole("link", { name: "Back" }).click();
  await waitForContent();
  const screenshot = process.env.R3_TEST_SCREENSHOT;
  if (screenshot) await page.screenshot({ path: screenshot });
  if (unsupported) {
    const beforeNavigation = externalRequests;
    await frame.locator("body").evaluate((_body: unknown, url: string) => {
      location.href = url;
    }, `http://localhost:${outside.port}/document`);
    await frame.getByRole("heading", { name: "External destination" }).waitFor();
    assert.ok(
      externalRequests > beforeNavigation,
      "external self-navigation is an acknowledged compatibility gap",
    );
    if (!(await page.getByRole("dialog", { name: "Artifact details", exact: true }).isVisible()))
      await page.getByRole("button", { name: "Artifact details and actions" }).click();
    await page.locator("[data-preview-security] > button[aria-expanded]").click();
    await page
      .getByText(/pages reached through navigation may have no network restrictions/)
      .waitFor();
    assert.equal(
      await page.locator('[data-preview-protection="network"]').getAttribute("data-state"),
      "limited",
    );
  }
  // Acknowledgment is site-wide, but a newly capable browser must still use
  // verified protection. Seeding a preference here does not mock the gate.
  if (!unsupported)
    await page.evaluate(() => localStorage.setItem("r3:preview-compatibility:v1", "accepted"));
  await page.reload();
  await waitForContent();
  assert.equal(await warning.count(), 0, "no repeated warning after acknowledgment");
  assert.equal(grants.at(-1)!.network, unsupported ? "compatible" : "blocked");
  await page.getByRole("button", { name: "Published version" }).click();
  await page.getByRole("option", { name: "Version 2", exact: true }).click();
  await waitForContent(2);
  assert.equal(await warning.count(), 0);
  assert.equal(grants.at(-1)!.network, unsupported ? "compatible" : "blocked");

  if (unsupported) {
    const second = await context.newPage();
    await second.goto(`${origin}/?artifact=${html.id}&version=1`);
    await second
      .frameLocator("[data-artifact-preview] iframe")
      .getByRole("heading", { name: "Version 1" })
      .waitFor();
    const old = grants.at(-1)!;
    if (!(await page.getByRole("dialog", { name: "Artifact details", exact: true }).isVisible()))
      await page.getByRole("button", { name: "Artifact details and actions" }).click();
    await page.locator("[data-preview-security] > button[aria-expanded]").click();
    await page.getByRole("button", { name: "Forget browser choice" }).click();
    await page.getByRole("button", { name: "Review browser risk" }).waitFor();
    await second.getByRole("button", { name: "Review browser risk" }).waitFor();
    assert.equal(await second.locator("[data-artifact-preview] iframe").count(), 0);
    assert.equal(
      (await fetch(old.gateUrl)).status,
      404,
      "forgetting revokes the active context in another tab",
    );
    await second.close();
    await page.reload();
    await warning.waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    const bounds = await warning.boundingBox();
    assert.ok(
      bounds &&
        bounds.x >= 0 &&
        bounds.x + bounds.width <= 390 &&
        bounds.y >= 0 &&
        bounds.y + bounds.height <= 844,
    );
    if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, "-warning.png") });
    await warning.getByRole("button", { name: "Accept risk and continue" }).click();
    await waitForContent(2);
    if (!(await page.getByRole("dialog", { name: "Artifact details", exact: true }).isVisible()))
      await page.getByRole("button", { name: "Artifact details and actions" }).click();
    await page.locator("[data-preview-security] > button[aria-expanded]").click();
    if (screenshot) await page.screenshot({ path: screenshot.replace(/\.png$/, "-details.png") });
    if (!(await page.getByRole("dialog", { name: "Artifact details", exact: true }).isVisible()))
      await page.getByRole("button", { name: "Artifact details and actions" }).click();
    await page.locator("[data-preview-security] > button[aria-expanded]").click();
  }

  // Transport/verification errors never become a consented network fallback.
  failCheck = true;
  const beforeFailure = grants.length;
  const beforeFiles = publicationRequests;
  await page.reload();
  await page
    .getByText("Could not verify preview isolation. Retry when the preview server is reachable.")
    .waitFor();
  assert.equal(await warning.count(), 0);
  assert.equal(publicationRequests, beforeFiles);
  assert.deepEqual(
    grants.slice(beforeFailure).map((grant) => grant.network),
    ["blocked"],
  );
  failCheck = false;
  await page.goto(`${origin}/?artifact=${files.id}&version=1`);
  await page.getByRole("button", { name: "Rendered", exact: true }).first().click();
  await waitForContent();
  assert.equal(
    await page.getByRole("button", { name: "Allow external access", exact: true }).count(),
    0,
  );
  assert.equal(await warning.count(), 0);
  assert.equal(grants.at(-1)!.network, unsupported ? "compatible" : "blocked");
  await context.close();

  if (unsupported) {
    // A readable store can still reject writes (quota/private-storage policies).
    // Consent should work for this app load without silently persisting it.
    const ephemeral = await browser.newContext();
    await ephemeral.addInitScript(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException("Unavailable", "QuotaExceededError");
      };
    });
    const deniedStorage = await ephemeral.newPage();
    await deniedStorage.goto(`${origin}/?artifact=${html.id}&version=1`);
    await deniedStorage.getByRole("button", { name: "Accept risk and continue" }).click();
    await deniedStorage
      .frameLocator("[data-artifact-preview] iframe")
      .getByRole("heading", { name: "Version 1" })
      .waitFor();
    await deniedStorage.reload();
    await deniedStorage.locator("[data-preview-compatibility-consent][open]").waitFor();
    await ephemeral.close();
  }
  console.log(
    `Compatibility acceptance: ${engine} ${browser.version()}; ${unsupported ? "consent, persistence, revocation, restrictive fallback" : "verified blocking despite saved compatibility consent"}, isolation, interaction, feedback, navigation, and version switching passed`,
  );
} finally {
  await browser?.close();
  app.stop(true);
  outside.stop(true);
  api.close();
  preview.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
