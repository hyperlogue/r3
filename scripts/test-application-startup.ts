import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplicationResponse, loadApplicationAssets } from "../server/application-assets.ts";
import { createArtifactApi } from "../server/artifact-api.ts";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import { COOKIE_NAME } from "../server/auth.ts";
import { PreviewHost } from "../server/preview-host.ts";
import { previewSupport } from "../server/preview-support.ts";
import { PREVIEW_RESUME_COOKIE } from "../shared/preview-resume.ts";

// Production SPA, isolated auth/storage, and a fresh browser. The latency is
// injected before API/preview responses, never attributed to database work.
const { chromium } = await import(process.env.R3_TEST_PLAYWRIGHT!);
const compatible = process.env.R3_TEST_COMPATIBLE === "1";
const assets = await loadApplicationAssets({ index: join(import.meta.dir, "../web/index.html") });
const controllerBuild = await Bun.build({
  entrypoints: [join(import.meta.dir, "../web/src/api.ts")],
  target: "browser",
});
if (!controllerBuild.success) throw new Error("Authentication controller build failed");
const root = await mkdtemp(join(tmpdir(), "r3-application-startup-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "agent" as const, sessionId: "startup-publisher" };
storage.artifacts.registerSession({ id: actor.sessionId, label: "Startup publisher" });
const artifact = storage.artifacts.create({
  kind: "html",
  actor,
  title: "Application startup fixture",
});
await storage.artifacts.publish(artifact.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "fixture",
  content: {
    kind: "html",
    files: [
      {
        path: "index.html",
        mediaType: "text/html",
        base64: Buffer.from(
          "<!doctype html><html><head><title>Startup</title></head><body><h1>Published fixture</h1><script>window.publisherStarted=true</script></body></html>",
        ).toString("base64"),
      },
    ],
  },
});
const preview = new PreviewHost(storage.artifacts, previewSupport);
const api = createArtifactApi(
  storage,
  {
    token: randomBytes(32).toString("base64url"),
    requireLogin: true,
    version: "acceptance",
    allowedHost: (host) => host === "localhost",
  },
  { previews: preview },
);
let mismatchPreviewOrigin = false;
const application = createApplicationResponse(assets, (request) => {
  const data = api.bootstrap(request);
  if (mismatchPreviewOrigin && data?.preview)
    data.preview.applicationOrigin = "https://other.example";
  return data;
});
let detailHold: Promise<void> | null = null;
let documentHold: Promise<void> | null = null;
let documentCaptured = () => {};
let eventsHold = false;
const trace: { path: string; at: number; end?: number; status?: number; conditional?: boolean }[] =
  [];
let navigation = 0;
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    const row = {
      path,
      at: performance.now() - navigation,
      end: undefined as number | undefined,
      status: undefined as number | undefined,
      conditional: request.headers.has("if-none-match"),
    };
    trace.push(row);
    if (path === "/controller.js")
      return new Response(controllerBuild.outputs[0], {
        headers: { "content-type": "text/javascript" },
      });
    if (path === "/controller")
      return new Response("<!doctype html><title>Auth controller</title>", {
        headers: { "content-type": "text/html" },
      });
    if (path.startsWith("/api/") || path.startsWith("/__r3_preview/")) await Bun.sleep(90);
    let response: Response;
    if (path.startsWith("/__r3_preview/")) response = await preview.fetch(request);
    else if (path.startsWith("/api/")) {
      if (path === `/api/artifacts/${artifact.id}`) await detailHold;
      if (path === "/api/events" && eventsHold) await Bun.sleep(2000);
      response = await api.app.fetch(request);
    } else {
      response = await application(request);
      if (path === `/${artifact.id}` && documentHold) {
        documentCaptured();
        await documentHold;
      }
    }
    row.end = performance.now() - navigation;
    row.status = response.status;
    return response;
  },
});
const base = `http://localhost:${app.port}`;
const url = `${base}/${artifact.id}?version=1&file=index.html&view=rendered`;
const outside = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () =>
    new Response(`<!doctype html><a href="${url}">Open fixture</a>`, {
      headers: { "content-type": "text/html" },
    }),
});
const browser = await chromium.launch({
  executablePath: process.env.R3_TEST_BROWSER,
  headless: true,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  if (compatible)
    await context.addInitScript(() =>
      localStorage.setItem("r3:preview-compatibility:v1", "accepted"),
    );
  const login = storage.authentication.createLoginToken("application startup acceptance");
  const session = storage.authentication.mintSession(login.info.id);
  await context.addCookies([
    {
      name: COOKIE_NAME,
      value: session.cookieValue,
      url: base,
      httpOnly: true,
      sameSite: "Strict",
    },
  ]);
  const page = await context.newPage();
  const ready = () =>
    page.locator('iframe[aria-hidden="false"]').first().waitFor({ timeout: 15000 });
  await page.goto(url);
  await ready();
  const firstPreviewUrl = await page
    .locator('iframe[aria-hidden="false"]')
    .first()
    .getAttribute("src");
  await page.goto("about:blank");
  trace.length = 0;
  navigation = performance.now();
  let releaseDetail!: () => void;
  detailHold = new Promise((resolve) => {
    releaseDetail = resolve;
  });
  eventsHold = true;
  await page.goto(url);
  await ready();
  assert.equal(
    await page.locator('iframe[aria-hidden="false"]').first().getAttribute("src"),
    firstPreviewUrl,
    "full application navigation preserves the preview URL",
  );
  const visibleMs = Math.round(performance.now() - navigation);
  assert.equal(
    trace.some((r) => r.path.startsWith("/api/previews/") || r.path.endsWith("/previews")),
    false,
    "HTML supplies preview setup without a separate create or renewal request",
  );
  assert.equal(
    trace.some((r) => r.path === "/api/boot"),
    false,
    "HTML supplies bootstrap",
  );
  assert.equal(
    trace.some((r) => r.path === "/api/sessions"),
    false,
    "artifact labels arrive with the detail",
  );
  assert.equal(
    trace.some((r) => r.path.endsWith("/files")),
    false,
    "HTML supplies the selected version manifest",
  );
  assert.equal(
    trace.some((r) => r.path === "/api/theme-style"),
    false,
    "HTML needs no source palette",
  );
  assert.equal(
    trace.some((r) => r.path.endsWith("/r3/runtime.js")),
    false,
  );
  assert.equal(
    trace.some((r) => r.path === `/api/artifacts/${artifact.id}` && r.end !== undefined),
    false,
    "embedded detail must open the workspace before an API detail read completes",
  );
  const check = trace.find((r) => r.path.endsWith("/r3/check"))!;
  const content = trace.find((r) => r.path.endsWith("/files/index.html"))!;
  // Some browser versions do not retain this opaque document in their cache.
  // When a validator is sent, renewal must preserve it and avoid the body transfer.
  assert.equal(content.status, content.conditional ? 304 : 200);
  if (compatible)
    assert.equal(
      trace.some((r) => /\/(?:r3\/(?:gate|check)|outside\/check)$/.test(r.path)),
      false,
      "embedded compatible setup preserves the no-probe choice",
    );
  else
    assert.ok(
      content.at >= check.end!,
      "embedded membership does not bypass successful verification",
    );
  await page.getByRole("button", { name: "Artifact details and actions" }).click();
  await page
    .getByRole("dialog", { name: "Artifact details" })
    .locator("summary")
    .getByText("Details", { exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Artifact details" })
    .getByText("Startup publisher")
    .waitFor();
  await page.keyboard.press("Escape");
  console.log(
    JSON.stringify({
      visibleMs,
      documentStatus: content.status,
      requestsBeforeVisible: trace.map((r) => ({
        path: r.path
          .replace(/artifact_\w+/g, ":artifact")
          .replace(/\/__r3_preview\/[^/]+/, "/__r3_preview/:context")
          .replace(/\/api\/previews\/[^/]+/, "/api/previews/:context")
          .replace(/\/chunk-[^/.]+/, "/chunk-[hash]")
          .replace(/\/favicon-[^/.]+/, "/favicon-[hash]"),
        at: Math.round(r.at),
      })),
    }),
  );
  releaseDetail();
  detailHold = null;
  eventsHold = false;
  await page.goto("about:blank");

  // Losing an optional hint must never discard this tab's retained URL.
  await context.clearCookies({ name: PREVIEW_RESUME_COOKIE });
  trace.length = 0;
  await page.goto(url);
  await ready();
  assert.equal(
    await page.locator('iframe[aria-hidden="false"]').first().getAttribute("src"),
    firstPreviewUrl,
  );
  assert.ok(
    trace.some((r) => r.path.startsWith("/api/previews/")),
    "missing hint renews the retained ID through the API",
  );
  await page.goto("about:blank");

  // Shared hints must not make independent tabs share a revocation lifetime.
  const second = await context.newPage();
  await second.goto(url);
  await second.locator('iframe[aria-hidden="false"]').first().waitFor();
  const secondUrl = await second.locator('iframe[aria-hidden="false"]').first().getAttribute("src");
  assert.notEqual(secondUrl, firstPreviewUrl);
  const secondId = new URL(secondUrl!).pathname.split("/")[2];
  await second.evaluate(async (id: string) => {
    const response = await fetch(`/api/previews/${id}`, { method: "DELETE" });
    if (!response.ok) throw new Error("Could not revoke isolated tab context");
  }, secondId);
  await second.close();
  trace.length = 0;
  await page.goto(url);
  await ready();
  assert.equal(
    await page.locator('iframe[aria-hidden="false"]').first().getAttribute("src"),
    firstPreviewUrl,
  );
  assert.equal(
    trace.some((r) => r.path.startsWith("/api/previews/") || r.path.endsWith("/previews")),
    false,
    "another tab's cleanup leaves inline renewal usable",
  );
  await page.goto("about:blank");

  // A proxy/canonical-origin mismatch must use authenticated setup for this
  // actual application origin rather than navigating to an unsuitable seed.
  mismatchPreviewOrigin = true;
  trace.length = 0;
  await page.goto(url);
  await ready();
  assert.ok(
    trace.some((r) => r.path.startsWith("/api/previews/") || r.path.endsWith("/previews")),
    "mismatched embedded origin falls back to authenticated preview setup",
  );
  mismatchPreviewOrigin = false;
  await page.goto("about:blank");

  // Cross-site entry omits Strict cookies; the loaded app must recover through
  // same-origin bootstrap rather than displaying a false signed-out snapshot.
  trace.length = 0;
  await page.goto(`http://127.0.0.1:${outside.port}`);
  await page.getByRole("link", { name: "Open fixture" }).click();
  await ready();
  assert.ok(
    trace.some((r) => r.path === "/api/boot"),
    "cross-site entry needs the bootstrap fallback",
  );

  // Hold HTML after it captured a valid session, then log out in another tab.
  // Unreadable storage must also reject the snapshot and use fresh authentication.
  const controller = await context.newPage();
  await controller.goto(`${base}/controller`);
  for (const storageUnavailable of [false, true]) {
    if (storageUnavailable)
      await page.addInitScript(() => {
        Object.defineProperty(window, "indexedDB", {
          get() {
            throw new Error("Storage unavailable for this document");
          },
        });
      });
    await page.goto("about:blank");
    trace.length = 0;
    let releaseDocument!: () => void;
    documentHold = new Promise((resolve) => {
      releaseDocument = resolve;
    });
    const captured = new Promise<void>((resolve) => {
      documentCaptured = resolve;
    });
    const pendingNavigation = page.goto(url);
    await captured;
    await controller.evaluate(async () => {
      const path = "/controller.js";
      const { api } = await import(path);
      await api.logout();
    });
    releaseDocument();
    documentHold = null;
    await pendingNavigation;
    await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor({ timeout: 5000 });
    assert.ok(
      trace.some((r) => r.path === "/api/boot"),
      "logout suspension forces fresh auth",
    );
    assert.equal(
      trace.some((r) => r.path.includes("/__r3_preview/")),
      false,
      "stale HTML must not open publisher content after logout",
    );
    const suspended = await controller.evaluate(async () => {
      const read = (name: string) =>
        new Promise<boolean>((resolve, reject) => {
          const opening = indexedDB.open(name);
          opening.onsuccess = () => {
            const db = opening.result;
            const req = db.transaction("state").objectStore("state").get("suspended");
            req.onsuccess = () => {
              db.close();
              resolve(Boolean(req.result));
            };
            req.onerror = () => reject(req.error);
          };
          opening.onerror = () => reject(opening.error);
        });
      return Promise.all([read("r3-markdown-cache-1:/"), read("r3-draft-images")]);
    });
    assert.deepEqual(suspended, [true, true]);
    await controller.evaluate(async (token: string) => {
      const path = "/controller.js";
      const { api } = await import(path);
      await api.login(token);
    }, login.token);
    trace.length = 0;
    await page.goto(url);
    await ready();
    assert.ok(
      trace.some((r) => r.path === "/api/boot"),
      "fresh login resumes caches through a current authenticated read",
    );
    await page.goto("about:blank");
    trace.length = 0;
    await page.goto(url);
    await ready();
    assert.equal(
      trace.some((r) => r.path === "/api/boot"),
      storageUnavailable,
      "inline bootstrap requires readable logout state; unavailable storage uses fresh auth",
    );
  }
  console.log(
    "Application startup: stable preview URL and conditional revalidation, zero setup request, missing-hint renewal, independent tabs, origin fallback, Strict-cookie entry, logout races with working/unavailable storage, and cache resumption passed",
  );
} finally {
  await browser.close();
  app.stop(true);
  outside.stop(true);
  api.close();
  preview.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
