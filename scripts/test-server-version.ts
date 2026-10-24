import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ApplicationAssets } from "../server/application-assets.ts";
import { startArtifactServer } from "../server/artifact-server.ts";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import { R3_VERSION } from "../shared/version.ts";
import { eventually, openTestBrowser } from "./browser.ts";
import { browserLoweredCssPlugin } from "./spa-css.ts";

const css = await browserLoweredCssPlugin();
async function buildAssets(version: string): Promise<ApplicationAssets> {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "server-version-fixture.ts")],
    target: "browser",
    naming: "[name]-[hash].[ext]",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      css,
      {
        name: "fixture release",
        setup(builder) {
          builder.onLoad({ filter: /shared[\\/]version\.ts$/ }, async (args) => ({
            contents: (await Bun.file(args.path).text()).replace(
              /export const R3_VERSION = "[^"]+";/,
              `export const R3_VERSION = ${JSON.stringify(version)};`,
            ),
            loader: "ts",
          }));
        },
      },
    ],
  });
  if (!build.success) throw new Error(`Version fixture failed to build: ${build.logs.join("\n")}`);
  const files: ApplicationAssets["files"] = new Map(
    build.outputs.map((output) => [
      `/${output.path.split("/").at(-1)!}`,
      { body: output, contentType: output.type, etag: `"${version}-${Bun.hash(output.path)}"` },
    ]),
  );
  const script = [...files.keys()].find((path) => path.endsWith(".js"));
  const stylesheet = [...files.keys()].find((path) => path.endsWith(".css"));
  return {
    files,
    index: {
      body: new Blob([
        `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="${stylesheet}"></head><body><div id="root"></div><script type="module" src="${script}"></script></body></html>`,
      ]),
      contentType: "text/html",
      etag: `"${version}"`,
    },
  };
}

const oldAssets = await buildAssets(R3_VERSION);
const upgradedVersion = "9999.0.0";
const newAssets = await buildAssets(upgradedVersion);
const root = await mkdtemp(join(tmpdir(), "r3-version-browser-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human" as const, sessionId: null };
const artifact = storage.artifacts.create({ kind: "files", actor, title: "Version acceptance" });
await storage.artifacts.publish(artifact.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "version-acceptance",
  content: {
    kind: "files",
    files: [
      {
        path: "notes.txt",
        mediaType: "text/plain",
        base64: Buffer.from("Keep reviewing while the server upgrades.").toString("base64"),
      },
    ],
  },
});
const token = randomBytes(32).toString("base64url");
const start = (version: string, assets: ApplicationAssets, port: number) =>
  startArtifactServer({
    storage,
    assets,
    bind: "127.0.0.1",
    port,
    authentication: {
      token,
      version,
      requireLogin: false,
      allowedHost: (host) => host === "localhost",
    },
  });
let runtime = start(R3_VERSION, oldAssets, 0);
const port = runtime.server.port!;
const base = `http://localhost:${port}`;
const url = `${base}/${artifact.id}?version=1`;
const browser = await openTestBrowser();
const external: string[] = [];
const stopListening = browser.listen((event) => {
  if (event.method === "Network.requestWillBeSent") {
    const requested = event.params.request.url as string;
    if (/^https?:/.test(requested) && new URL(requested).origin !== base) external.push(requested);
  }
});
try {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  await page.command("Network.enable");
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.command("Page.navigate", { url });
  await eventually(
    () => page.evaluate("!!document.querySelector('[aria-label=\"Add comment\"]')"),
    "workspace ready",
  );
  assert.equal(await page.evaluate("document.querySelectorAll('[data-server-version]').length"), 0);
  await page.evaluate(
    "document.querySelector('[aria-label=\"Add comment\"]').click();window.versionVisit = 'original'",
  );
  await eventually(
    () => page.evaluate("!!document.querySelector('[data-artifact-composer] textarea')"),
    "draft composer",
  );
  await page.evaluate("document.querySelector('[data-artifact-composer] textarea').focus()");
  await page.command("Input.insertText", { text: "Draft before upgrade" });

  // The actual listener restarts at the same address. The old tab must discover
  // the new release through its ordinary outgoing requests/SSE reconnect.
  await runtime.stop();
  runtime = start(upgradedVersion, newAssets, port);
  await eventually(
    () =>
      page.evaluate(
        `document.querySelector('[data-server-version]')?.dataset.serverVersion === '${upgradedVersion}'`,
      ),
    "upgrade notice after server restart",
  );
  assert.equal(await page.evaluate("window.versionVisit"), "original", "No automatic reload");
  assert.equal(
    await page.evaluate("document.activeElement?.tagName"),
    "TEXTAREA",
    "No focus theft",
  );
  await page.evaluate(
    "Promise.all([window.versionFixture.themes(), window.versionFixture.list()])",
  );
  await Bun.sleep(5200);
  assert.equal(
    await page.evaluate("document.querySelectorAll('[data-server-version]').length"),
    1,
    "Repeated responses neither duplicate nor dismiss the notice",
  );
  assert.equal(
    await page.evaluate("document.querySelectorAll('[data-notifications]').length"),
    1,
    "Workspace reuses the application notification stack",
  );

  for (const width of [1440, 390, 320]) {
    await page.command("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });
    for (const dark of [false, true]) {
      await page.evaluate(`document.documentElement.classList.toggle('dark', ${dark})`);
      const geometry = await page.evaluate(`(() => {
        const card = document.querySelector('[data-server-version]').getBoundingClientRect();
        const text = document.querySelector('.r3-server-update-copy').getBoundingClientRect();
        const button = document.querySelector('.r3-server-update-action').getBoundingClientRect();
        return { fits: card.left >= 0 && card.right <= innerWidth && card.bottom <= innerHeight,
          aligned: Math.abs(text.top - button.top) < 1 && Math.abs(text.height - button.height) < 1,
          height: card.height };
      })()`);
      assert.equal(geometry.fits, true);
      assert.equal(geometry.aligned, true);
      assert.ok(geometry.height < (width === 320 ? 120 : 90));
    }
  }
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  if (process.env.R3_TEST_SCREENSHOT) {
    const screenshot = await page.command("Page.captureScreenshot", { format: "png" });
    await Bun.write(process.env.R3_TEST_SCREENSHOT, Buffer.from(screenshot.data, "base64"));
  }

  // Force a storage failure and click in the same task, before the 400ms debounce.
  await page.evaluate(`(() => {
    window.originalDraftSave = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key.startsWith('r3-artifact-draft-slot-')) throw new Error('Storage unavailable');
      window.originalDraftSave.call(this, key, value);
    };
    window.versionFixture.editDraft('${artifact.id}', 'Latest unsaved draft');
    document.querySelector('.r3-server-update-action').click();
  })()`);
  await eventually(
    () => page.evaluate("document.body.textContent.includes('Drafts couldn’t be saved.')"),
    "save failure prevents reload",
  );
  assert.equal(await page.evaluate("window.versionVisit"), "original");
  await page.evaluate(
    `Storage.prototype.setItem = window.originalDraftSave; window.versionFixture.editDraft('${artifact.id}', 'Last keystroke before refresh'); document.querySelector('.r3-server-update-action').click()`,
  );
  await eventually(
    () =>
      page.evaluate(
        `window.versionFixture?.version === '${upgradedVersion}' && !!document.querySelector('[data-app-header]')`,
      ),
    "explicit refresh loads the new bundle",
  );
  assert.equal(await page.evaluate("location.href"), url, "Refresh retains the selected route");
  assert.equal(
    await page.evaluate(`window.versionFixture.draft('${artifact.id}')?.body`),
    "Last keystroke before refresh",
  );
  assert.equal(await page.evaluate("document.querySelectorAll('[data-server-version]').length"), 0);

  await runtime.stop();
  runtime = start(upgradedVersion, newAssets, port);
  await eventually(
    () => page.evaluate("window.versionFixture.list().then(() => true).catch(() => false)"),
    "same-version restart reconnects",
  );
  assert.equal(await page.evaluate("document.querySelectorAll('[data-server-version]').length"), 0);
  await runtime.stop();
  runtime = start(R3_VERSION, oldAssets, port);
  await eventually(
    () =>
      page.evaluate(
        "document.querySelector('[data-server-version]')?.textContent.includes('Server changed')",
      ),
    "downgrade uses neutral wording",
  );
  assert.deepEqual(external, [], "Version detection makes no external requests");
  console.log(
    "Version acceptance passed: real restart/reconnect, persistent notice, no focus theft or duplicate stack, both themes and mobile, draft-save failure/retry, immediate draft flush, explicit new-bundle reload, same-release restart, downgrade, and no external requests.",
  );
} finally {
  stopListening();
  await browser.close();
  await runtime.stop();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
