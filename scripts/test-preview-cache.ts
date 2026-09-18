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

// All bytes, browser state, and servers belong to this isolated acceptance run.
const playwright = await import(process.env.R3_TEST_PLAYWRIGHT!);
const engine = process.env.R3_TEST_ENGINE ?? "chromium";
const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "preview-workspace-fixture.tsx")],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [await browserLoweredCssPlugin()],
});
if (!build.success) throw new Error("Cache fixture build failed");
const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
const js = [...assets.keys()].find((path) => path.endsWith(".js"))!;
const css = [...assets.keys()].find((path) => path.endsWith(".css"));
const root = await mkdtemp(join(tmpdir(), "r3-cache-acceptance-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human" as const, sessionId: null };
const files = storage.artifacts.create({ kind: "files", actor, title: "Cache files" });
const html = storage.artifacts.create({ kind: "html", actor, title: "Cache HTML" });
const markdownPage = storage.artifacts.create({
  kind: "html",
  actor,
  title: "Markdown entrypoint",
});
for (let seq = 1; seq <= 2; seq++) {
  for (const artifact of [files, html, markdownPage]) {
    const markdown = artifact.kind === "files" || artifact.id === markdownPage.id;
    await storage.artifacts.publish(artifact.id, {
      actor,
      expectedSeq: seq - 1,
      publicationKey: `version-${seq}`,
      content: {
        kind: artifact.kind,
        files: [
          {
            path: markdown ? "index.md" : "index.html",
            mediaType: markdown ? "text/markdown" : "text/html",
            base64: Buffer.from(
              markdown
                ? `# Cache document ${seq}\n\n${Array.from({ length: 80 }, (_, i) => `## Section ${i + 1}\n\nPublished paragraph ${i + 1}.\n`).join("\n")}`
                : `<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><h1>Cache HTML ${seq}</h1>${"<p>Published paragraph</p>".repeat(120)}<script>window.publisherStarted = true</script></body></html>`,
            ).toString("base64"),
          },
          ...(markdown
            ? [
                ...Array.from({ length: 5 }, (_, index) => ({
                  path: `page-${index + 1}.md`,
                  mediaType: "text/markdown",
                  base64: Buffer.from(
                    `# Additional document ${index + 1}\n\n${"Published paragraph.\n\n".repeat(80)}\n\n## Destination\n\nNative fragment target.`,
                  ).toString("base64"),
                })),
                {
                  path: "r3-guide.txt",
                  mediaType: "text/plain",
                  base64: Buffer.from("Published command help\n".repeat(40)).toString("base64"),
                },
              ]
            : []),
          ...(!markdown
            ? [
                {
                  path: "style.css",
                  mediaType: "text/css",
                  base64: Buffer.from("body{font:18px sans-serif}p{margin:40px}").toString(
                    "base64",
                  ),
                },
              ]
            : []),
        ],
      },
    });
  }
}
const preview = new PreviewHost(storage.artifacts, undefined, previewSupport);
const api = createArtifactApi(
  storage,
  {
    token: randomBytes(32).toString("base64url"),
    requireLogin: false,
    version: "cache-acceptance",
    allowedHost: (host) => host === "localhost",
  },
  { previews: preview },
);
const documents: { path: string; status: number }[] = [];
const sources: number[] = [];
const runtimes: number[] = [];
let creations = 0;
let gates = 0;
let verifications = 0;
let markdownReads = 0;
let gateHold: Promise<void> | null = null;
let bootHold: Promise<void> | null = null;
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith(PREVIEW_PREFIX)) {
      if (path.endsWith("/r3/gate")) await gateHold;
      const response = await preview.fetch(request);
      if (path.endsWith("/r3/gate")) gates++;
      if (path.endsWith("/r3/verify")) verifications++;
      if (path.endsWith("/r3/markdown")) markdownReads++;
      if (path.endsWith("/r3/runtime.js")) runtimes.push(response.status);
      if (
        path.includes("/files/") &&
        ["iframe", "frame"].includes(request.headers.get("sec-fetch-dest") ?? "")
      )
        documents.push({ path, status: response.status });
      return response;
    }
    if (path.startsWith("/api/")) {
      if (path === "/api/boot") await bootHold;
      if (path.endsWith("/previews") && request.method === "POST") creations++;
      const response = await api.app.fetch(request);
      if (path.endsWith("/source")) sources.push(response.status);
      return response;
    }
    const asset = assets.get(path.slice(1));
    if (asset) return new Response(asset);
    return new Response(
      `<!doctype html><html><head>${css ? `<link rel="stylesheet" href="/${css}">` : ""}<style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style></head><body><div id="root"></div><script type="module" src="/${js}"></script></body></html>`,
      {
        headers: {
          "content-type": "text/html",
          "content-security-policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
        },
      },
    );
  },
});
const browser = await playwright[engine].launch({
  headless: true,
  executablePath: process.env.R3_TEST_BROWSER,
  ...(engine === "chromium" ? { args: ["--no-sandbox", "--disable-dev-shm-usage"] } : {}),
});
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const base = `http://localhost:${app.port}`;
  let step = 0;
  const ready = async () => {
    step++;
    try {
      await page.locator('iframe[aria-hidden="false"]').first().waitFor({ timeout: 20000 });
    } catch {
      throw new Error(`Preview step ${step} failed: ${await page.locator("body").innerText()}`);
    }
  };
  await page.goto(`${base}/${files.id}?version=1&file=index.md&view=rendered`);
  if (process.env.R3_TEST_UNSUPPORTED === "1")
    await page.getByRole("button", { name: "Accept risk and continue" }).click();
  await ready();
  assert.equal(
    creations,
    process.env.R3_TEST_UNSUPPORTED === "1" ? 2 : 1,
    "opening one document must not initialize offscreen Markdown previews",
  );
  const firstPath = documents.at(-1)!.path;
  assert.equal(documents.at(-1)!.status, 200);
  assert.equal(runtimes.at(-1), 200);
  assert.equal(markdownReads, 1, "only the opened Markdown document is downloaded");
  const card = page.locator('[data-file="index.md"]');
  const paneAt = async (y: number) => {
    try {
      await page.waitForFunction(
        (target: number) =>
          Math.abs((document.querySelector("[data-artifact-content]")?.scrollTop ?? -1) - target) <
          2,
        y,
        { timeout: 10000 },
      );
    } catch {
      const actual = await page
        .locator("[data-artifact-content]")
        .evaluate((pane: HTMLElement) => pane.scrollTop);
      throw new Error(`Reading offset ${y} was not restored (actual ${actual})`);
    }
  };
  const savedAt = async (y: number, path = "index.md", view = "rendered") => {
    const url = new URL(page.url());
    const key = JSON.stringify([
      url.pathname.slice(1),
      Number(url.searchParams.get("version")),
      path,
      view,
    ]);
    try {
      await page.waitForFunction(
        ({ target, key }: { target: number; key: string }) =>
          JSON.parse(sessionStorage.getItem("r3-reading-positions-1") ?? "[]").some(
            (entry: [string, { y: number }]) => entry[0] === key && entry[1].y === target,
          ),
        { target: y, key },
        { timeout: 10000 },
      );
    } catch {
      throw new Error(`Reading offset ${y} was not persisted`);
    }
  };
  await page
    .locator("[data-artifact-content]")
    .evaluate((pane: HTMLElement) => pane.scrollTo(0, 1500));
  await savedAt(1500);
  await card.getByRole("button", { name: "Source", exact: true }).click();
  await card.locator("[data-line]").first().waitFor({ state: "attached" });
  await card.getByRole("button", { name: "Rendered", exact: true }).click();
  await ready();
  await paneAt(1500);
  assert.deepEqual(documents.at(-1), { path: firstPath, status: 304 });
  assert.equal(runtimes.at(-1), 304, "the trusted runtime also revalidates its cached bytes");
  const beforeRefresh = creations;
  const beforeGate = gates;
  let releaseGate!: () => void;
  let releaseBoot!: () => void;
  gateHold = new Promise((resolve) => {
    releaseGate = resolve;
  });
  bootHold = new Promise((resolve) => {
    releaseBoot = resolve;
  });
  const bootRequested = page.waitForRequest(
    (request: any) => new URL(request.url()).pathname === "/api/boot",
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await bootRequested;
  assert.equal(
    await page.locator("[data-markdown-reading]").count(),
    0,
    "cached reading still waits for ordinary app authentication",
  );
  releaseBoot();
  bootHold = null;
  await page
    .frameLocator("[data-markdown-reading]")
    .getByRole("heading", { name: "Cache document 1", exact: true })
    .waitFor();
  await paneAt(1500);
  assert.equal(
    markdownReads,
    1,
    "early reading uses local bytes while the preview gate is pending",
  );
  await page
    .locator("[data-artifact-content]")
    .evaluate((pane: HTMLElement) => pane.scrollTo(0, 1600));
  await paneAt(1600);
  await page
    .locator("[data-artifact-content]")
    .evaluate((pane: HTMLElement) => pane.scrollTo(0, 1500));
  await savedAt(1500);
  releaseGate();
  gateHold = null;
  await ready();
  assert.equal(
    await page.locator("[data-markdown-reading]").count(),
    0,
    "interactive preview replaces the passive reader after verification",
  );
  await paneAt(1500);
  assert.equal(
    creations,
    beforeRefresh + (process.env.R3_TEST_UNSUPPORTED === "1" ? 1 : 0),
    "refresh renews the document context; unsupported browsers still retry the blocked gate",
  );
  assert.ok(gates > beforeGate, "refresh must still run the browser gate");
  assert.deepEqual(documents.at(-1), { path: firstPath, status: 304 });
  assert.equal(runtimes.at(-1), 304, "page refresh retains the runtime response");
  assert.equal(markdownReads, 1, "refresh and source switches reuse persistent Markdown bytes");
  await card.getByRole("button", { name: "Source", exact: true }).click();
  await card.locator("[data-line]").first().waitFor({ state: "attached" });
  assert.equal(sources.at(-1), 304, "source link revisits reuse the HTTP response");
  await card.getByRole("button", { name: "Rendered", exact: true }).click();
  await ready();
  const version = async (seq: number) => {
    await page.getByRole("button", { name: "Published version", exact: true }).click();
    await page.getByRole("option", { name: `Version ${seq}`, exact: true }).click();
    await ready();
    await page
      .frameLocator('iframe[aria-hidden="false"]')
      .getByRole("heading", { name: new RegExp(` ${seq}$`), level: 1 })
      .waitFor();
  };
  await version(2);
  await paneAt(0);
  await version(1);
  await paneAt(1500);
  assert.deepEqual(documents.at(-1), { path: firstPath, status: 304 });
  assert.equal(markdownReads, 2, "each opened version downloads its Markdown only once");
  preview.close();
  await page.reload();
  await ready();
  await paneAt(1500);
  assert.notEqual(documents.at(-1)!.path, firstPath, "expired contexts get fresh scoped URLs");
  assert.equal(markdownReads, 2, "a replacement context still reuses the same immutable bytes");
  console.log(
    `${engine}: Markdown refresh, source toggles, historical visits reuse validated responses`,
  );

  const firstFrame = await card.locator("iframe").elementHandle();
  await page.locator('button[title="page-5.md"]').click();
  const lastCard = page.locator('[data-file="page-5.md"]');
  await lastCard.locator('iframe[aria-hidden="false"]').waitFor();
  assert.equal(await firstFrame!.evaluate((frame: HTMLElement) => frame.isConnected), true);
  await page.locator('button[title="index.md"]').click();
  await paneAt(0);
  await page.locator('button[title="page-5.md"]').click();
  const beforeFold = documents.length;
  const lastFrame = await lastCard.locator("iframe").elementHandle();
  await lastCard.getByTitle("Collapse", { exact: true }).click();
  await lastCard.getByTitle("Expand", { exact: true }).click();
  assert.equal(await lastFrame!.evaluate((frame: HTMLElement) => frame.isConnected), true);
  assert.equal(documents.length, beforeFold, "folding keeps the loaded Markdown frame");
  await page.locator('button[title="page-1.md"]').click();
  await page.locator('[data-file="page-1.md"] iframe[aria-hidden="false"]').waitFor();
  const laterPosition = await page.evaluate(async () => {
    const pane = document.querySelector<HTMLElement>("[data-artifact-content]")!;
    const file = document.querySelector('[data-file="page-1.md"]')!;
    // A retained iframe is already ready while the explicit file jump still
    // aligns its header. Start reading only after that alignment has settled.
    const toolbar =
      Number.parseFloat(getComputedStyle(pane).getPropertyValue("--pane-sticky-h")) || 0;
    const deadline = performance.now() + 10000;
    let stable = 0;
    while (stable < 6) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const aligned =
        Math.abs(file.getBoundingClientRect().top - pane.getBoundingClientRect().top - toolbar) < 2;
      stable = aligned ? stable + 1 : 0;
      if (performance.now() > deadline) throw new Error("Later file jump did not settle");
    }
    const top = Math.round(
      pane.scrollTop + file.getBoundingClientRect().top - pane.getBoundingClientRect().top + 500,
    );
    pane.scrollTo(0, top);
    return top;
  });
  await savedAt(laterPosition, "page-1.md");
  await page.reload();
  await paneAt(laterPosition);
  await page.waitForFunction(
    () => document.querySelectorAll('iframe[aria-hidden="false"]').length === 2,
  );
  assert.equal(
    await page.locator('iframe[aria-hidden="false"]').count(),
    2,
    "restoring a later offset hydrates only its required document prefix",
  );
  console.log(`${engine}: deferred file jumps and folding retain measured Markdown frames`);

  await page.goto(`${base}/${markdownPage.id}?version=1`);
  await ready();
  const beforeExpiry = markdownReads;
  preview.close();
  const expiredRenewal = page.waitForResponse(
    (response: any) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname.startsWith("/api/previews/"),
  );
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  assert.equal((await expiredRenewal).status(), 404);
  await page.getByRole("button", { name: "Retry preview", exact: true }).click();
  await ready();
  assert.equal(
    markdownReads,
    beforeExpiry,
    "an expired live context must not purge the artifact's retained Markdown",
  );
  const markdownFrame = () =>
    page.frames().find((frame: any) => frame.url().includes("/files/index.md"))!;
  await markdownFrame().evaluate(() => scrollTo(0, 700));
  await savedAt(700, "index.md", "rendered:#");
  gateHold = new Promise((resolve) => {
    releaseGate = resolve;
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page
    .frameLocator("[data-markdown-reading]")
    .getByRole("heading", { name: "Cache document 1", exact: true })
    .waitFor();
  const passiveFrame = page.frames().find((frame: any) => frame.url() === "about:srcdoc")!;
  await passiveFrame.waitForFunction(() => Math.abs(scrollY - 700) < 2);
  await passiveFrame.evaluate(() => scrollTo(0, 900));
  await savedAt(900, "index.md", "rendered:#");
  releaseGate();
  gateHold = null;
  await ready();
  await markdownFrame().waitForFunction(() => Math.abs(scrollY - 900) < 2);
  await markdownFrame().evaluate(() => {
    const link = document.createElement("a");
    link.href = "page-1.md#destination";
    document.body.prepend(link);
    link.click();
  });
  await page
    .frameLocator('iframe[aria-hidden="false"]')
    .getByRole("heading", { name: "Additional document 1", exact: true })
    .waitFor();
  const destination = page
    .frames()
    .find((frame: any) => frame.url().includes("/files/page-1.md#destination"))!;
  await destination
    .waitForFunction(
      () => {
        const rect = document.getElementById("destination")?.getBoundingClientRect();
        return rect && rect.top >= 0 && rect.bottom <= innerHeight;
      },
      undefined,
      { timeout: 10000 },
    )
    .catch(async () => {
      const position = await destination.evaluate(() => ({
        y: scrollY,
        top: document.getElementById("destination")?.getBoundingClientRect().top,
      }));
      throw new Error(`Native Markdown fragment was not restored: ${JSON.stringify(position)}`);
    });
  console.log(
    `${engine}: Markdown entrypoints keep reading position across passive/interactive replacement`,
  );

  await page.goto(`${base}/${html.id}?version=1`);
  await ready();
  const htmlPath = documents.at(-1)!.path;
  const frame = () => page.frames().find((frame: any) => frame.url().includes("/files/"))!;
  await frame().evaluate(() => scrollTo(0, 900));
  await savedAt(900, "index.html", "rendered:#");
  await page.reload();
  await ready();
  await frame().waitForFunction(() => Math.abs(scrollY - 900) < 2);
  assert.deepEqual(documents.at(-1), { path: htmlPath, status: 304 });
  await version(2);
  await version(1);
  await frame().waitForFunction(() => Math.abs(scrollY - 900) < 2);
  assert.deepEqual(documents.at(-1), { path: htmlPath, status: 304 });
  assert.equal(
    await page
      .frameLocator('iframe[aria-hidden="false"]')
      .locator("body")
      .evaluate(() => globalThis.origin),
    "null",
  );
  storage.artifacts.delete(html.id);
  preview.revokeArtifact(html.id);
  api.collaboration.deleted(html.id);
  await page.getByRole("alert").waitFor();
  assert.equal(await page.locator("iframe").count(), 0);
  assert.equal(
    await page.evaluate(
      (id: string) => (sessionStorage.getItem("r3-preview-sessions-1") ?? "").includes(id),
      html.id,
    ),
    false,
  );
  assert.equal(
    await page.evaluate(
      (id: string) => (sessionStorage.getItem("r3-reading-positions-1") ?? "").includes(id),
      html.id,
    ),
    false,
  );
  console.log(
    `${engine}: HTML refresh/version cache hits retain opaque isolation; deletion removes preview handles`,
  );
  const cachedFileCount = () =>
    page.evaluate(async (artifactId: string) => {
      const opening = indexedDB.open("r3-markdown-cache-1:/", 1);
      const database: IDBDatabase = await new Promise((resolve, reject) => {
        opening.onsuccess = () => resolve(opening.result);
        opening.onerror = () => reject(opening.error);
      });
      const read = database.transaction("entries").objectStore("entries").getAll();
      const entries: { artifactId: string }[] = await new Promise((resolve, reject) => {
        read.onsuccess = () => resolve(read.result);
        read.onerror = () => reject(read.error);
      });
      database.close();
      return entries.filter((entry) => entry.artifactId === artifactId).length;
    }, files.id);
  assert.ok((await cachedFileCount()) > 0, "opened Markdown remains cached before deletion");
  storage.artifacts.delete(files.id);
  preview.revokeArtifact(files.id);
  api.collaboration.deleted(files.id);
  const deletionDeadline = Date.now() + 5000;
  while ((await cachedFileCount()) > 0 && Date.now() < deletionDeadline)
    await page.waitForTimeout(25);
  assert.equal(await cachedFileCount(), 0, "deletion events purge persistent Markdown bytes");
  assert.equal(
    verifications,
    0,
    "reopening cached documents requires no server challenge exchange",
  );
} finally {
  await browser.close();
  app.stop(true);
  api.close();
  preview.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
