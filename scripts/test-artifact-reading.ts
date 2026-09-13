import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactApi } from "../server/artifact-api.ts";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import { eventually, openTestBrowser } from "./browser.ts";
import { browserLoweredCssPlugin } from "./spa-css.ts";

// Exercise computed browser styles and reading interactions against real
// publication/source/diff endpoints, with no normal daemon or user profile.
const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "preview-workspace-fixture.tsx")],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [await browserLoweredCssPlugin()],
});
if (!build.success) throw new Error("Reading acceptance workspace failed to build");
const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
const script = build.outputs
  .find((output) => output.path.endsWith(".js"))!
  .path.split("/")
  .at(-1)!;
const css = build.outputs
  .find((output) => output.path.endsWith(".css"))!
  .path.split("/")
  .at(-1)!;
const root = await mkdtemp(join(tmpdir(), "r3-reading-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human" as const, sessionId: null };
const source = Array.from(
  { length: 80 },
  (_, index) => `export const greeting${index}: string = "Hello";\n`,
).join("");
const files = storage.artifacts.create({ kind: "files", actor, title: "Published source" });
await storage.artifacts.publish(files.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "source",
  content: {
    kind: "files",
    files: [
      {
        path: "source.ts",
        mediaType: "text/plain",
        base64: Buffer.from(source).toString("base64"),
      },
      {
        path: "z-last.ts",
        mediaType: "text/plain",
        base64: Buffer.from("export const last = true;\n").toString("base64"),
      },
    ],
  },
});
const diff = storage.artifacts.create({ kind: "diff", actor, title: "Published diff" });
const feedback = await storage.conversations.add(files.id, {
  actor,
  body: "Keep the original reading controls.",
  target: {
    kind: "source",
    versionSeq: 1,
    path: "source.ts",
    locator: { start: 1, end: 1, quote: source.split("\n")[0] },
  },
});
storage.artifacts.registerSession({ id: "reading-agent", harness: "acceptance" });
const discussion = await storage.conversations.add(files.id, {
  actor,
  body: "Keep the file list synchronized with the content pane.",
  target: { kind: "source", versionSeq: 1, path: "source.ts", locator: null },
});
for (const body of [
  "I checked the original navigation.",
  "File headers stay foldable.",
  "Each publication keeps all its files.",
  "The file list now follows your scroll position. Please check the restored reading controls.",
]) {
  await storage.conversations.addReply(discussion.id, {
    actor: { role: "agent", sessionId: "reading-agent" },
    body,
    context: { versionSeq: 1, representation: "source" },
  });
}
await storage.artifacts.publish(diff.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "diff",
  content: {
    kind: "diff",
    patch: `diff --git a/source.ts b/source.ts\n--- a/source.ts\n+++ b/source.ts\n@@ -1 +1,80 @@\n-export const greeting: string = "Before";\n${source
      .trimEnd()
      .split("\n")
      .map((line) => `+${line}`)
      .join(
        "\n",
      )}\ndiff --git a/z-last.ts b/z-last.ts\n--- a/z-last.ts\n+++ b/z-last.ts\n@@ -1 +1 @@\n-export const last = false;\n+export const last = true;\n`,
  },
});
const api = createArtifactApi(storage, {
  token: randomBytes(32).toString("base64url"),
  requireLogin: false,
  version: "acceptance",
  allowedHost: (host) => host === "localhost",
});
let lastSourceRequested = 0;
let lastSourceCompleted = 0;
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;
    const lastRequest =
      path.endsWith("/source") && url.searchParams.get("path") === "part-31.ts"
        ? ++lastSourceRequested
        : 0;
    // A remote publisher's content need not arrive within a few paint frames.
    if (path.endsWith("/source") && url.searchParams.get("path")?.startsWith("part-"))
      await Bun.sleep(url.searchParams.get("path") === "part-31.ts" ? 600 : 200);
    if (path.startsWith("/api/")) {
      const response = await api.app.fetch(request);
      if (lastRequest) lastSourceCompleted = lastRequest;
      return response;
    }
    const asset = assets.get(path.slice(1));
    if (asset) return new Response(asset);
    return new Response(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/${css}"><style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style></head><body><div id="root"></div><script type="module" src="/${script}"></script></body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
let browser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
try {
  browser = await openTestBrowser();
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 1400,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  for (const artifact of [files, diff]) {
    await page.command("Page.navigate", {
      url: `http://localhost:${app.port}/?artifact=${artifact.id}&version=1`,
    });
    await eventually(
      () => page.evaluate("!!document.querySelector('.shiki-code span')"),
      "published tokens",
    );
    await eventually(
      () => page.evaluate("!!document.querySelector('style[data-r3-theme-css]')?.textContent"),
      "syntax palette",
    );
    for (const dark of [false, true]) {
      await page.evaluate(`document.documentElement.classList.toggle('dark', ${dark})`);
      const colors = await page.evaluate<string[]>(
        "[...new Set([...document.querySelectorAll('.shiki-code span')].map(node => getComputedStyle(node).color))]",
      );
      assert(
        colors.length > 1,
        `${artifact.kind} ${dark ? "dark" : "light"}: published tokens must have distinct syntax colors; got ${colors.join(", ")}`,
      );
    }
    assert.equal(
      await page.evaluate("document.querySelectorAll('[data-file]').length"),
      2,
      "all publication files stay in one pane",
    );
    await eventually(
      () => page.evaluate("!!document.querySelector('[data-file=\"z-last.ts\"] [data-line]')"),
      "all source bodies loaded",
    );
    await page.evaluate(
      "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
    );
    await page.evaluate("document.querySelector('[data-artifact-content]').scrollTop = 100000");
    await eventually(
      () =>
        page.evaluate(
          "document.querySelector('button[title=\"z-last.ts\"]')?.className.includes('bg-neutral-200/70')",
        ),
      "file-list highlight follows scrolling",
    );
    await page.evaluate("document.querySelector('button[title=\"Fold all files\"]').click()");
    await eventually(
      () =>
        page.evaluate(
          "document.querySelectorAll('[data-file] button[title=\"Expand\"]').length === 2",
        ),
      "fold all files",
    );
    await page.evaluate("document.querySelector('button[title=\"source.ts\"]').click()");
    await eventually(
      () =>
        page.evaluate(
          '!!document.querySelector(\'[data-file="source.ts"] button[title="Collapse"]\')',
        ),
      "file list unfolds selected file",
    );
    assert.equal(
      await page.evaluate("document.querySelectorAll('[data-file]').length"),
      2,
      "file selection preserves the stack",
    );
    if (artifact.id === files.id) {
      assert.equal(
        await page.evaluate("!!document.querySelector('[aria-label=\"Feedback\"]')"),
        false,
        "composer opens on demand",
      );
      await page.evaluate(
        "document.querySelector('[aria-label=\"Add general feedback\"]').click()",
      );
      await eventually(
        () => page.evaluate("!!document.querySelector('[aria-label=\"Feedback\"]')"),
        "general composer",
      );
      assert(
        await page.evaluate(`(() => {
        const composer = document.querySelector('[data-artifact-composer]');
        const list = document.querySelector('[data-feedback-list]');
        return !!(composer.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING);
      })()`),
        "composer precedes the thread list",
      );
      await page.evaluate("document.querySelector('[aria-label=\"Feedback\"]').focus()");
      await page.command("Input.insertText", { text: "A draft blocks handoff" });
      assert(
        await page.evaluate(
          "[...document.querySelectorAll('button')].find(b=>b.textContent==='Copy prompt').disabled",
        ),
      );
      await page.evaluate(
        "[...document.querySelectorAll('[data-artifact-composer] button')].find(b=>b.textContent==='Discard').click()",
      );
      await page.evaluate(
        `document.querySelector('[data-artifact-feedback="${feedback.id}"] button').click()`,
      );
      const expandedWidth = await page.evaluate(
        "document.querySelector('[data-artifact-content]').getBoundingClientRect().width",
      );
      await page.evaluate("document.querySelector('[aria-label=\"Float feedback\"]').click()");
      const contentWidth = await page.evaluate(
        "document.querySelector('[data-artifact-content]').getBoundingClientRect().width",
      );
      assert(Number(contentWidth) > Number(expandedWidth), "expanded reserves content space");
      assert.equal(
        await page.evaluate("document.querySelector('[data-feedback-mode]').dataset.feedbackMode"),
        "floating",
      );
      await page.evaluate("document.querySelector('[aria-label=\"Hide feedback\"]').click()");
      assert.equal(
        await page.evaluate(
          "document.querySelector('[data-artifact-content]').getBoundingClientRect().width",
        ),
        contentWidth,
        "floating and hidden preserve the same content width",
      );
      await page.evaluate(`document.querySelector('[data-fb-id="${feedback.id}"] code').click()`);
      await eventually(
        () => page.evaluate("!!document.querySelector('[data-artifact-thread-popover]')"),
        "anchor opens one floating thread",
      );
      assert(
        await page.evaluate("!!document.querySelector('[aria-label=\"Show feedback\"]')"),
        "thread leaves the full panel folded",
      );
      await page.evaluate(
        "document.querySelector('[data-artifact-thread-popover] [data-feedback-action=reply]').click()",
      );
      await eventually(
        () => page.evaluate("!!document.querySelector('[data-artifact-thread-popover] textarea')"),
        "thread reply composer",
      );
      await page.evaluate(
        "document.querySelector('[data-artifact-thread-popover] textarea').focus()",
      );
      await page.command("Input.insertText", { text: "Retain the popover draft" });
      await page.evaluate("document.querySelector('[aria-label=\"Close thread\"]').click()");
      await page.evaluate(`document.querySelector('[data-fb-id="${feedback.id}"] code').click()`);
      await eventually(
        () => page.evaluate("!!document.querySelector('[data-artifact-thread-popover]')"),
        "reopen anchored thread",
      );
      await page.evaluate(
        "document.querySelector('[data-artifact-thread-popover] [data-feedback-action=reply]').click()",
      );
      await eventually(
        () =>
          page.evaluate(
            "document.querySelector('[data-artifact-thread-popover] textarea')?.value === 'Retain the popover draft'",
          ),
        "popover draft survives dismissal",
      );
      await page.evaluate("document.querySelector('[aria-label=\"Close thread\"]').click()");

      await page.command("Input.dispatchKeyEvent", { type: "keyDown", key: "e", code: "KeyE" });
      await page.command("Input.dispatchKeyEvent", { type: "keyUp", key: "e", code: "KeyE" });
      await Bun.sleep(200);
      assert.equal(
        storage.conversations.get(feedback.id).status,
        "open",
        "folded feedback has no invisible resolve shortcut",
      );
      await page.command("Emulation.setDeviceMetricsOverride", {
        width: 390,
        height: 844,
        deviceScaleFactor: 1,
        mobile: true,
      });
      await eventually(
        () => page.evaluate("!document.querySelector('[aria-label=\"Show feedback\"]')"),
        "mobile closed sheet",
      );
      await page.command("Input.dispatchKeyEvent", { type: "keyDown", key: "e", code: "KeyE" });
      await page.command("Input.dispatchKeyEvent", { type: "keyUp", key: "e", code: "KeyE" });
      await Bun.sleep(200);
      assert.equal(
        storage.conversations.get(feedback.id).status,
        "open",
        "closed mobile sheet has no invisible resolve shortcut",
      );
      await page.command("Emulation.setDeviceMetricsOverride", {
        width: 1400,
        height: 1000,
        deviceScaleFactor: 1,
        mobile: false,
      });
      await eventually(
        () => page.evaluate("!!document.querySelector('[aria-label=\"Show feedback\"]')"),
        "desktop dock restored",
      );
      await page.evaluate("document.querySelector('[aria-label=\"Show feedback\"]').click()");
      await eventually(
        () =>
          page.evaluate(
            "document.querySelector('[data-feedback-mode]')?.dataset.feedbackMode === 'floating'",
          ),
        "reopening restores floating mode",
      );
      await page.evaluate("document.querySelector('[aria-label=\"Expand feedback\"]').click()");
      await eventually(
        async () =>
          Number(
            await page.evaluate(
              "document.querySelector('[data-artifact-content]').getBoundingClientRect().width",
            ),
          ) === Number(expandedWidth),
        "expanding reserves the panel width again",
      );
      await page.command("Input.dispatchKeyEvent", { type: "keyDown", key: "e", code: "KeyE" });
      await page.command("Input.dispatchKeyEvent", { type: "keyUp", key: "e", code: "KeyE" });
      await eventually(
        async () => storage.conversations.get(feedback.id).status === "resolved",
        "visible resolve shortcut",
      );
      await eventually(
        () =>
          page.evaluate(
            `!document.querySelector('[data-artifact-feedback="${feedback.id}"]') && [...document.querySelectorAll('[role=tab]')].some(b=>b.textContent==='Resolved 1')`,
          ),
        "active queue advances after resolve",
      );
      await page.evaluate(
        "[...document.querySelectorAll('[role=tab]')].find(b=>b.textContent.startsWith('Resolved')).click()",
      );
      await eventually(
        () =>
          page.evaluate(`!!document.querySelector('[data-artifact-feedback="${feedback.id}"]')`),
        "resolved tab retains the thread",
      );
    }
  }
  await storage.artifacts.publish(files.id, {
    actor,
    expectedSeq: 1,
    publicationKey: "many-files",
    content: {
      kind: "files",
      files: Array.from({ length: 32 }, (_, index) => ({
        path: `part-${String(index).padStart(2, "0")}.ts`,
        mediaType: "text/plain",
        base64: Buffer.from(`export const part = ${index};\n`.repeat(100)).toString("base64"),
      })),
    },
  });
  await page.command("Page.navigate", {
    url: `http://localhost:${app.port}/?artifact=${files.id}&version=2`,
  });
  await eventually(
    () => page.evaluate("document.querySelectorAll('[data-file]').length === 32"),
    "complete progressive file stack",
  );
  await page.evaluate("document.querySelector('button[title=\"part-31.ts\"]').click()");
  await eventually(
    () => page.evaluate("!!document.querySelector('[data-file=\"part-31.ts\"] [data-line]')"),
    "distant file hydrates on explicit navigation",
  );
  await eventually(
    () =>
      page.evaluate(`(() => {
      const pane = document.querySelector('[data-artifact-content]');
      const file = pane.querySelector('[data-file="part-31.ts"]');
      const top = file.getBoundingClientRect().top - pane.getBoundingClientRect().top;
      const first = file.querySelector('[data-line="1"]');
      return top >= -1 && top < 50 && first && first.getBoundingClientRect().top >= pane.getBoundingClientRect().top + 60;
    })()`),
    "distant file aligns after delayed hydration",
  );
  assert.equal(await page.evaluate("document.querySelectorAll('[data-file]').length"), 32);
  assert(
    await page.evaluate("document.querySelectorAll('[data-line]').length < 1000"),
    "offscreen file bodies remain deferred",
  );
  if (process.env.R3_TEST_SCREENSHOT) {
    const shot = await page.command("Page.captureScreenshot", { format: "png" });
    await Bun.write(process.env.R3_TEST_SCREENSHOT, Buffer.from(shot.data, "base64"));
  }
  const previousRequest = lastSourceRequested;
  await page.command("Page.reload");
  await eventually(
    () => page.evaluate("document.querySelectorAll('[data-file]').length === 32"),
    "fresh source cache for competing jumps",
  );
  await page.evaluate("document.querySelector('button[title=\"part-31.ts\"]').click()");
  await eventually(async () => lastSourceRequested > previousRequest, "delayed jump started");
  await page.evaluate("document.querySelector('button[title=\"part-00.ts\"]').click()");
  await eventually(
    () => page.evaluate("!!document.querySelector('[data-file=\"part-00.ts\"] [data-line]')"),
    "newer jump hydrates",
  );
  await eventually(async () => lastSourceCompleted > previousRequest, "older response completed");
  await page.evaluate("new Promise(resolve=>setTimeout(resolve,200))");
  assert(
    await page.evaluate(`(() => {
      const pane = document.querySelector('[data-artifact-content]');
      const file = pane.querySelector('[data-file="part-00.ts"]');
      const top = file.getBoundingClientRect().top - pane.getBoundingClientRect().top;
      return top >= -1 && top < 50;
    })()`),
    "late hydration cannot steal a newer file selection",
  );
  for (const mode of ["floating", "expanded"] as const) {
    const control = mode === "floating" ? "Float feedback" : "Expand feedback";
    await page.evaluate(`document.querySelector('[aria-label="${control}"]')?.click()`);
    await eventually(
      () =>
        page.evaluate(
          `document.querySelector('[data-feedback-mode]')?.dataset.feedbackMode === '${mode}'`,
        ),
      `select ${mode} feedback`,
    );
    await page.evaluate("document.querySelector('[aria-label=\"Hide feedback\"]').click()");
    // Reload through about:blank so no assertion can observe the old document.
    const url = await page.evaluate<string>("location.href");
    await page.command("Page.navigate", { url: "about:blank" });
    await page.command("Page.navigate", { url });
    await eventually(
      () =>
        page.evaluate(
          "document.querySelector('[data-feedback-mode]')?.dataset.feedbackMode === 'hidden'",
        ),
      "hidden mode survives reload",
    );
    assert(
      await page.evaluate(`(() => {
        const panel = document.querySelector('[data-feedback-mode]');
        const toggle = document.querySelector('[data-app-header] [aria-label="Show feedback"]');
        const content = document.querySelector('[data-artifact-content-view]').getBoundingClientRect();
        const workspace = panel.parentElement.getBoundingClientRect();
        return panel.getBoundingClientRect().width === 0 && content.right === workspace.right &&
          !!toggle && !panel.querySelector('[aria-label="Show feedback"]');
      })()`),
      "hidden feedback leaves no rail or reserved gutter and is controlled by the navbar",
    );
    const point = await page.evaluate<{ x: number; y: number }>(`(() => {
      const bounds = document.querySelector('[aria-label="Show feedback"]').getBoundingClientRect();
      return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    })()`);
    await page.command("Input.dispatchMouseEvent", {
      type: "mousePressed",
      ...point,
      button: "left",
      clickCount: 1,
    });
    await page.command("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      ...point,
      button: "left",
      clickCount: 1,
    });
    await eventually(
      () =>
        page.evaluate(
          `document.querySelector('[data-feedback-mode]')?.dataset.feedbackMode === '${mode}'`,
        ),
      "the navbar button restores the remembered mode",
    );
    for (const expected of ["hidden", mode]) {
      await page.command("Input.dispatchKeyEvent", { type: "keyDown", key: "p", code: "KeyP" });
      await page.command("Input.dispatchKeyEvent", { type: "keyUp", key: "p", code: "KeyP" });
      await eventually(
        () =>
          page.evaluate(
            `document.querySelector('[data-feedback-mode]')?.dataset.feedbackMode === '${expected}'`,
          ),
        "keyboard toggle respects the remembered mode",
      );
    }
  }
  console.log(
    "Published files/diffs: syntax colors, complete stack, folding, file navigation and scroll highlighting passed",
  );
} finally {
  await browser?.close();
  app.stop(true);
  api.close();
  await storage.close();
  await rm(root, { recursive: true, force: true });
}
