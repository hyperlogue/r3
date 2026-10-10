import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactApi } from "../server/artifact-api.ts";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import { eventually, openTestBrowser } from "./browser.ts";
import { browserLoweredCssPlugin } from "./spa-css.ts";

const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "../web/src/main.tsx")],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [await browserLoweredCssPlugin()],
});
if (!build.success) throw new Error("Display preference acceptance app failed to build");
const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
const assetName = (suffix: string) =>
  build.outputs
    .find((output) => output.path.endsWith(suffix))!
    .path.split("/")
    .at(-1)!;
const root = await mkdtemp(join(tmpdir(), "r3-display-preferences-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human", sessionId: null } as const;
const artifact = storage.artifacts.create({ kind: "files", actor, title: "Display preferences" });
await storage.artifacts.publish(artifact.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "display-preferences",
  content: {
    kind: "files",
    files: ["first.ts", "nested/second.ts"].map((path) => ({
      path,
      mediaType: "text/plain",
      base64: Buffer.from("const captured = true;\n").toString("base64"),
    })),
  },
});
const api = createArtifactApi(storage, {
  token: randomBytes(32).toString("base64url"),
  requireLogin: false,
  version: "acceptance",
  allowedHost: (host) => host === "localhost",
});
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 60,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) return api.app.fetch(request);
    const asset = assets.get(path.slice(1));
    if (asset) return new Response(asset);
    return new Response(
      `<!doctype html><html><head><link rel="stylesheet" href="/${assetName(".css")}"></head><body><div id="root"></div><script type="module" src="/${assetName(".js")}"></script></body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
let browser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
try {
  for (const mode of ["denied", "quota"] as const) {
    browser = await openTestBrowser(
      [],
      mode === "denied"
        ? { profile: { default_content_setting_values: { cookies: 2 } } }
        : undefined,
    );
    const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
    const page = await browser.attach(targetId);
    await page.command("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await page.command("Emulation.setEmulatedMedia", {
      features: [
        { name: "prefers-color-scheme", value: "light" },
        { name: "prefers-reduced-motion", value: "reduce" },
      ],
    });
    await page.command("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.preferenceErrors = [];
        addEventListener("error", event => window.preferenceErrors.push(event.message));
        ${
          mode === "quota"
            ? `
        localStorage.setItem("r3-filebrowser-width", "260");
        localStorage.setItem("r3-filebrowser-collapsed", "0");
        for (const method of ["setItem", "removeItem"]) {
          const original = Storage.prototype[method];
          Storage.prototype[method] = function(...args) {
            if (this === window.localStorage) throw new DOMException("Storage unavailable", "QuotaExceededError");
            return original.apply(this, args);
          };
        }`
            : ""
        }`,
    });
    await page.command("Page.navigate", { url: `http://localhost:${app.port}/${artifact.id}` });
    const fileHandle = '[role="separator"][aria-label="Resize file panel"]';
    const exists = (selector: string) =>
      page.evaluate<boolean>(`!!document.querySelector(${JSON.stringify(selector)})`);
    const click = async (selector: string) => {
      assert(await exists(selector), `${mode}: control exists: ${selector}`);
      await page.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    };
    const key = (selector: string, value: string) =>
      page.evaluate(
        `document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new KeyboardEvent("keydown", {key:${JSON.stringify(value)}, bubbles:true}))`,
      );
    const width = () =>
      page.evaluate<number>(
        `Number(document.querySelector(${JSON.stringify(fileHandle)}).getAttribute("aria-valuenow"))`,
      );
    await eventually(() => exists(fileHandle), `${mode}: workspace opens with the file panel`);
    await eventually(
      () => page.evaluate("document.body.textContent.includes('const captured')"),
      `${mode}: captured source renders`,
    );
    if (mode === "denied") {
      assert.equal(
        await page.evaluate(
          `(() => {try {localStorage.getItem("probe"); return false;} catch (error) {return error.name === "SecurityError";}})()`,
        ),
        true,
      );
    }
    const initial = await width();
    await key(fileHandle, "ArrowRight");
    await eventually(async () => (await width()) === initial + 10, `${mode}: resize works`);
    await key(fileHandle, "Home");
    await eventually(async () => (await width()) === 252, `${mode}: width reset works`);
    await click('[title="Hide files"]');
    await eventually(() => exists('[title="Show files"]'), `${mode}: file panel collapses`);
    await click('[title="Show files"]');
    await eventually(() => exists(fileHandle), `${mode}: file panel expands`);
    await click('[aria-label="Artifact details and actions"]');
    await eventually(
      () => exists('[aria-label="Artifact details"]'),
      `${mode}: artifact menu opens`,
    );
    await page.evaluate(
      `Array.from(document.querySelectorAll('[aria-label="Artifact details"] button')).find(button => button.textContent.includes("Settings")).click()`,
    );
    const settings = '[role="dialog"][aria-label="Settings"]';
    await eventually(() => exists(settings), `${mode}: settings open`);
    await page.evaluate(
      `Array.from(document.querySelectorAll(${JSON.stringify(`${settings} button`)})).find(button => button.textContent === "+").click()`,
    );
    await eventually(
      () =>
        page.evaluate(
          "document.body.textContent.includes('Font size · 19px') && document.documentElement.style.getPropertyValue('--r3-font-size') === '19px'",
        ),
      `${mode}: font subscribers and CSS update`,
    );
    await page.evaluate(
      `Array.from(document.querySelectorAll(${JSON.stringify(`${settings} button`)})).find(button => button.textContent.includes("Dark")).click()`,
    );
    await eventually(
      () => page.evaluate("document.documentElement.classList.contains('dark')"),
      `${mode}: theme changes`,
    );
    await click('[aria-label="Close settings"]');
    await click('[aria-label="Float discussion"]');
    await eventually(() => exists('[aria-label="Dock discussion"]'), `${mode}: threads floats`);
    const mover = '[aria-label="Move discussion"]';
    await eventually(() => exists(mover), `${mode}: floating controls mount`);
    const floatingX = () =>
      page.evaluate<number>(
        `document.querySelector(${JSON.stringify(mover)}).closest("[data-discussion-mode]").getBoundingClientRect().x`,
      );
    const previousX = await floatingX();
    await key(mover, "ArrowLeft");
    await eventually(
      async () => (await floatingX()) < previousX,
      `${mode}: floating geometry changes`,
    );
    await click('[aria-label="Dock discussion"]');
    await eventually(() => exists('[aria-label="Float discussion"]'), `${mode}: discussion docks`);
    const rememberedWidth = (await width()) + 10;
    await key(fileHandle, "ArrowRight");
    await eventually(
      async () => (await width()) === rememberedWidth,
      `${mode}: width changes before navigation`,
    );
    await click('[title="Hide files"]');
    await click('a[href="/"]');
    const artifactLink = `a[href="/${artifact.id}"]`;
    await eventually(() => exists(artifactLink), `${mode}: artifact home opens`);
    await click(artifactLink);
    await eventually(
      () => exists('[title="Show files"]'),
      `${mode}: collapsed preference survives remount`,
    );
    await click('[title="Show files"]');
    await eventually(
      async () => (await exists(fileHandle)) && (await width()) === rememberedWidth,
      `${mode}: width preference survives remount`,
    );
    assert.deepEqual(
      await page.evaluate("window.preferenceErrors"),
      [],
      `${mode}: no uncaught storage errors`,
    );
    await browser.close();
    browser = undefined;
  }
  console.log(
    "Display preference acceptance passed: denied storage still opens files; quota failures preserve display controls.",
  );
} finally {
  await browser?.close();
  app.stop(true);
  api.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
