import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactApi } from "../server/artifact-api.ts";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import { PREVIEW_PREFIX } from "../server/preview-contexts.ts";
import { PreviewHost } from "../server/preview-host.ts";
import { previewSupport } from "../server/preview-support.ts";
import { eventually, openTestBrowser } from "./browser.ts";
import { browserLoweredCssPlugin } from "./spa-css.ts";

// The real application, a temporary backend, and a fresh browser profile. No demo
// artifact data or onboarding overrides are injected into the application.
const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "../web/src/main.tsx")],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [await browserLoweredCssPlugin()],
});
if (!build.success) throw new Error(`Onboarding app build failed: ${build.logs}`);
const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
const js = build.outputs
  .find((output) => output.path.endsWith(".js"))!
  .path.split("/")
  .at(-1)!;
const css = build.outputs
  .find((output) => output.path.endsWith(".css"))!
  .path.split("/")
  .at(-1)!;
const root = await mkdtemp(join(tmpdir(), "r3-onboarding-browser-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human" as const, sessionId: null };
const diff = storage.artifacts.create({
  kind: "diff",
  actor,
  title: "The actual published change",
});
for (const seq of [1, 2])
  await storage.artifacts.publish(diff.id, {
    actor,
    expectedSeq: seq - 1,
    publicationKey: `diff-${seq}`,
    content: {
      kind: "diff",
      patch: `diff --git a/main.ts b/main.ts\n--- a/main.ts\n+++ b/main.ts\n@@ -1 +1 @@\n-export const version = 0;\n+export const version = ${seq};\n`,
    },
  });
const html = storage.artifacts.create({ kind: "html", actor, title: "Actual HTML publication" });
await storage.artifacts.publish(html.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "html",
  content: {
    kind: "html",
    files: [
      {
        path: "index.html",
        mediaType: "text/html",
        base64: Buffer.from("<!doctype html><h1>Published page</h1>").toString("base64"),
      },
    ],
  },
});
const files = storage.artifacts.create({
  kind: "files",
  actor,
  title: "Actual source publication",
});
await storage.artifacts.publish(files.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "files",
  content: {
    kind: "files",
    files: [
      {
        path: "main.ts",
        mediaType: "text/plain",
        base64: Buffer.from("export const value = 42;\n").toString("base64"),
      },
    ],
  },
});
const renderedFiles = storage.artifacts.create({
  kind: "files",
  actor,
  title: "Actual Markdown publication",
});
await storage.artifacts.publish(renderedFiles.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "markdown",
  content: {
    kind: "files",
    files: [
      {
        path: "README.md",
        mediaType: "text/markdown",
        base64: Buffer.from("# Published document\n\nComment on this passage.\n").toString(
          "base64",
        ),
      },
    ],
  },
});
const preview = new PreviewHost(storage.artifacts, previewSupport);
const api = createArtifactApi(
  storage,
  {
    token: "test",
    requireLogin: false,
    disableLoginNotice: true,
    version: "acceptance",
    allowedHost: (host) => host === "localhost",
  },
  { previews: preview },
);
let reads = 0;
const firstRead = Promise.withResolvers<void>();
let rejectSave = false;
const writes: string[] = [];
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/api/onboarding") {
      if (request.method === "GET" && ++reads === 1) await firstRead.promise;
      if (request.method === "PUT" && rejectSave)
        return Response.json({ error: "Offline" }, { status: 503 });
    }
    if (path.startsWith(PREVIEW_PREFIX)) return preview.fetch(request);
    if (path.startsWith("/api/")) {
      if (!["GET", "HEAD"].includes(request.method)) writes.push(path);
      return api.app.fetch(request);
    }
    const asset = assets.get(path.slice(1));
    if (asset) return new Response(asset);
    return new Response(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/${css}"></head><body><div id="root"></div><script type="module" src="/${js}"></script></body></html>`,
      { headers: { "content-type": "text/html", "cache-control": "no-store" } },
    );
  },
});
const url = `http://localhost:${app.port}`;
let browser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
let secondBrowser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
const shadow = 'document.querySelector("[data-product-tour]")?.shadowRoot';
try {
  browser = await openTestBrowser();
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  const press = async (key: string) => {
    await page.command("Input.dispatchKeyEvent", { type: "keyDown", key });
    await page.command("Input.dispatchKeyEvent", { type: "keyUp", key });
  };
  const click = async (expression: string) => {
    let previous = "";
    const point = await eventually(async () => {
      const candidate = await page.evaluate(`(() => {
        const element = (${expression});
        if (!element || element.disabled) return null;
        const r = element.getBoundingClientRect();
        const x = r.x+r.width/2, y = r.y+r.height/2;
        const hit = element.getRootNode().elementFromPoint(x, y);
        if (!hit || !element.contains(hit)) return null;
        return {x,y};
      })()`);
      const key = JSON.stringify(candidate);
      const stable = candidate && previous === key;
      previous = key;
      return stable ? candidate : null;
    }, `stable clickable control: ${expression}`);
    await page.command("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...point,
    });
    await page.command("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...point,
    });
  };
  const next = () => click(`${shadow}.querySelector('.tour-primary')`);
  const step = async (id: string) => {
    try {
      return await eventually(
        () =>
          page.evaluate(
            `${shadow}?.querySelector('[data-step]')?.dataset.step === ${JSON.stringify(id)}`,
          ),
        `tour step ${id}`,
      );
    } catch (error) {
      await screenshot(`failure-${id}`);
      console.log(
        await page.evaluate(
          `({tour: ${shadow}?.textContent, dialogs: [...document.querySelectorAll('[role=dialog]')].map(e=>e.textContent)})`,
        ),
      );
      throw error;
    }
  };
  const screenshot = async (name: string) => {
    if (!process.env.R3_TEST_SCREENSHOTS) return;
    await mkdir(process.env.R3_TEST_SCREENSHOTS, { recursive: true });
    const image = await page.command("Page.captureScreenshot", { format: "png" });
    await Bun.write(
      join(process.env.R3_TEST_SCREENSHOTS, `${name}.png`),
      Buffer.from(image.data, "base64"),
    );
  };
  const checkBounds = async () =>
    assert.equal(
      await page.evaluate(`(() => {
    const r = ${shadow}.querySelector('.tour-card').getBoundingClientRect();
    return r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
  })()`),
      true,
      "tour fits the viewport",
    );
  const checkSpotlight = async (selector: string) => {
    const geometry = await page.evaluate(`(() => {
      const target = [...document.querySelectorAll(${JSON.stringify(selector)})].find(element => element.checkVisibility()).getBoundingClientRect();
      const spot = ${shadow}.querySelector('.tour-spotlight').getBoundingClientRect();
      const expected = [Math.max(0, target.left - 5), Math.max(0, target.top - 5), Math.min(innerWidth, target.right + 5), Math.min(innerHeight, target.bottom + 5)];
      return { target: [target.left, target.top, target.right, target.bottom], expected, actual: [spot.left, spot.top, spot.right, spot.bottom] };
    })()`);
    assert.ok(
      geometry.actual.every(
        (edge: number, index: number) => Math.abs(edge - geometry.expected[index]) < 1,
      ),
      `Spotlight must align with ${selector}: ${JSON.stringify(geometry)}`,
    );
  };
  const checkMovingSpotlight = async () => {
    const samples = await page.evaluate(`new Promise(resolve => {
      const samples = []; const start = performance.now();
      const sample = () => {
        const target = document.querySelector('[data-tour=comment]').getBoundingClientRect();
        const spot = ${shadow}.querySelector('.tour-spotlight').getBoundingClientRect();
        if (target.top >= 0 && target.bottom <= innerHeight && target.left >= 0 && target.right <= innerWidth) {
          const expected = [Math.max(0, target.left - 5), Math.max(0, target.top - 5), Math.min(innerWidth, target.right + 5), Math.min(innerHeight, target.bottom + 5)];
          const actual = [spot.left, spot.top, spot.right, spot.bottom];
          samples.push({ targetTop: target.top, spotTop: spot.top, error: Math.max(...actual.map((edge,index)=>Math.abs(edge-expected[index]))) });
        }
        if (performance.now()-start < 350) requestAnimationFrame(sample); else resolve(samples);
      }; requestAnimationFrame(sample);
    })`);
    assert.ok(samples.length > 0, "native comment button becomes visible");
    const worst = samples.reduce((a: { error: number }, b: { error: number }) =>
      a.error > b.error ? a : b,
    );
    assert.ok(
      worst.error < 1,
      `Spotlight must follow each animation frame: ${JSON.stringify(worst)}`,
    );
  };
  const stepTarget = (id: string) =>
    (
      ({
        versions: '[data-tour="versions"], [data-tour="details"]',
        files: '[data-tour="files"]',
        anchor: "[data-gutter]",
        "comment-mode": '[data-tour="comment-mode"]',
        comment: '[data-tour="comment"]',
        handoff: "[data-discussion-header] [data-artifact-handoff]",
        threads: '[data-discussion-header] [role="tablist"]',
      }) as Record<string, string>
    )[id]!;
  const restart = async () => {
    await click('document.querySelector("[data-tour=details]")');
    await eventually(
      () =>
        page.evaluate(
          '!![...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Settings")',
        ),
      "settings menu item",
    );
    await click(
      '[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Settings")',
    );
    await click(
      '[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Take the product tour")',
    );
    await step("content");
  };
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 1400,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.command("Page.navigate", { url });
  await eventually(
    () => page.evaluate('document.body?.textContent.includes("The actual published change")'),
    "library loads",
  );
  assert.equal(reads, 0, "library does not start or fetch onboarding");
  assert.equal(await page.evaluate(`!!${shadow}`), false);
  await page.evaluate(`localStorage.setItem('r3-feedback-collapsed', 'hidden')`);
  await page.command("Page.navigate", { url: `${url}/${diff.id}?version=1` });
  await eventually(
    () => page.evaluate('!!document.querySelector("[data-tour=details]")'),
    "first artifact controls",
  );
  await press("?");
  await eventually(
    () => page.evaluate(`!!document.querySelector('[role="dialog"] input[type="search"]')`),
    "command palette before tour",
  );
  firstRead.resolve();
  await page.evaluate('fetch("/api/onboarding").then(r=>r.json())');
  assert.equal(await page.evaluate(`!!${shadow}`), false, "existing dialog takes precedence");
  await press("Escape");
  await step("content");
  assert.equal(
    await page.evaluate('document.body?.textContent.includes("The actual published change")'),
    true,
  );
  assert.equal(await page.evaluate('document.querySelector("[data-tour=versions]").value'), "1");
  await checkSpotlight("[data-artifact-content-view]");
  await screenshot("onboarding-desktop");
  for (const key of ["n", "S", ">", "f", "?"]) await press(key);
  assert.equal(
    await page.evaluate('document.querySelector("[data-tour=versions]").value'),
    "1",
    "shortcuts cannot change the artifact behind the tour",
  );
  await press("Tab");
  assert.equal(
    await page.evaluate(`${shadow}.activeElement.classList.contains('tour-skip')`),
    true,
    "Tab wraps within the tour",
  );
  for (const id of ["versions", "files", "anchor", "comment", "handoff", "threads"]) {
    await next();
    await step(id);
    await checkBounds();
    if (id === "comment") await checkMovingSpotlight();
    await checkSpotlight(stepTarget(id));
    if (id === "versions") {
      await page.command("Emulation.setDeviceMetricsOverride", {
        width: 1100,
        height: 800,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await page.evaluate(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
      await checkSpotlight(stepTarget(id));
      await checkBounds();
    }
  }
  rejectSave = true;
  await next();
  await eventually(
    () => page.evaluate(`!!${shadow}.querySelector('[role=alert]')`),
    "save failure remains actionable",
  );
  assert.equal(storage.onboarding.read().status, "new");
  rejectSave = false;
  await next();
  await eventually(() => page.evaluate(`!${shadow}`), "finish closes tour");
  assert.equal(storage.onboarding.read().status, "completed");
  assert.equal(await page.evaluate('document.querySelector("[data-tour=versions]").value'), "1");
  assert.equal(storage.conversations.list(diff.id).length, 0);
  assert.deepEqual(writes, ["/api/onboarding"], "tour produces only the completion write");
  await page.command("Page.reload");
  await eventually(
    () => page.evaluate('!!document.querySelector("[data-tour=details]")'),
    "reloaded artifact",
  );
  await page.evaluate('fetch("/api/onboarding").then(r=>r.json())');
  assert.equal(await page.evaluate(`!!${shadow}`), false, "completed tour does not auto-restart");
  assert.equal(
    await page.evaluate('document.querySelector("[data-discussion-mode]").dataset.discussionMode'),
    "hidden",
    "desktop layout restored after tour",
  );
  await press("p");
  await eventually(
    () =>
      page.evaluate(
        'document.querySelector("[data-discussion-mode]").dataset.discussionMode !== "hidden"',
      ),
    "show discussion",
  );
  // A draft survives manual replay; a skipped replay cannot downgrade completion.
  await click('document.querySelector("[data-tour=comment]")');
  await eventually(() => page.evaluate('!!document.querySelector("textarea")'), "draft composer");
  await click('document.querySelector("textarea")');
  await page.command("Input.insertText", { text: "Keep my draft intact" });
  await restart();
  await press("Escape");
  await eventually(() => page.evaluate(`!${shadow}`), "Escape skips replay");
  assert.equal(
    await page.evaluate('document.querySelector("textarea").value'),
    "Keep my draft intact",
  );
  assert.equal(storage.onboarding.read().status, "completed");
  secondBrowser = await openTestBrowser();
  const another = await secondBrowser.send("Target.createTarget", { url: "about:blank" });
  const second = await secondBrowser.attach(another.targetId);
  await second.command("Page.navigate", { url: `${url}/${diff.id}` });
  await eventually(
    () => second.evaluate('!!document.querySelector("[data-tour=details]")'),
    "second browser artifact",
  );
  assert.equal(
    await second.evaluate('fetch("/api/onboarding").then(r=>r.json()).then(s=>s.status)'),
    "completed",
    "completion shared with another browser",
  );
  assert.equal(await second.evaluate(`!!${shadow}`), false);
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  for (const artifact of [diff, files, html, renderedFiles]) {
    const hasCommentMode = artifact.kind === "html" || artifact.id === renderedFiles.id;
    // Remembered preview compatibility consent is confined to this fresh test profile.
    await page.evaluate(`localStorage.setItem('r3:preview-compatibility:v1', 'accepted')`);
    await page.command("Page.navigate", { url: `${url}/${artifact.id}` });
    await eventually(
      () => page.evaluate('!!document.querySelector("[data-tour=details]")'),
      "phone artifact",
    );
    await restart();
    assert.equal(
      await page.evaluate(
        `${shadow}.querySelector('.tour-heading').textContent.includes(${JSON.stringify(`1 of ${artifact.kind === "html" ? 6 : 7}`)})`,
      ),
      true,
      "tour count excludes the removed Settings stop",
    );
    for (const id of [
      "versions",
      ...(artifact.kind === "html" ? [] : ["files"]),
      hasCommentMode ? "comment-mode" : "anchor",
      "comment",
      "handoff",
      "threads",
    ]) {
      await next();
      await step(id);
      await checkBounds();
      if (id === "comment") {
        await checkMovingSpotlight();
        await eventually(
          () =>
            page.evaluate(
              `!document.querySelector('[data-mobile-discussion=sheet]').getAnimations().some(animation => animation.playState === 'running')`,
            ),
          "native sheet transition finishes",
        );
        await eventually(
          () =>
            page.evaluate(`(() => {
          const target = document.querySelector('[data-tour=comment]').getBoundingClientRect();
          const spot = ${shadow}.querySelector('.tour-spotlight').getBoundingClientRect();
          return Math.abs(spot.top - target.top + 5) < 1;
        })()`),
          "spotlight follows the native sheet",
        );
        await screenshot(`onboarding-phone-${artifact.kind}`);
      }
      await checkSpotlight(stepTarget(id));
      if (id === "comment-mode") {
        assert.equal(
          await page.evaluate(`${shadow}.querySelector('#tour-title').textContent`),
          "Use Comment mode",
        );
        assert.equal(
          await page.evaluate(
            'document.querySelector("[data-tour=comment-mode]").getAttribute("aria-pressed")',
          ),
          "false",
          "tour explains Comment mode without activating it",
        );
        await screenshot(`onboarding-comment-mode-${artifact.kind}`);
      }
    }
    assert.equal(
      await page.evaluate(`${shadow}.querySelector('.tour-primary').textContent`),
      "Finish",
      "finish at discussion instead of a replay reminder",
    );
    await next();
    await eventually(() => page.evaluate(`!${shadow}`), "phone finish");
    assert.equal(
      await page.evaluate('document.querySelector("[data-mobile-discussion=sheet]")?.inert'),
      true,
      "phone sheet returns to its closed state",
    );
  }
  console.log(
    "Onboarding acceptance passed: real artifacts, first entry, replay, persistence, keyboard, save failure, desktop and phone.",
  );
} finally {
  await secondBrowser?.close();
  await browser?.close();
  app.stop(true);
  api.close();
  preview.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
