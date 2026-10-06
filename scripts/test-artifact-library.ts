// Full application acceptance with temporary storage and a fresh browser.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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

const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "../web/src/main.tsx")],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [await browserLoweredCssPlugin()],
});
if (!build.success)
  throw new Error(
    `Library browser build failed: ${build.logs.map((log) => log.message).join("; ")}`,
  );
const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
const js = build.outputs
  .find((output) => output.path.endsWith(".js"))!
  .path.split("/")
  .at(-1)!;
const css = build.outputs
  .find((output) => output.path.endsWith(".css"))!
  .path.split("/")
  .at(-1)!;
const root = await mkdtemp(join(tmpdir(), "r3-library-acceptance-"));
let clockNow = new Date().toISOString();
const storage = await openArtifactStorage({
  databasePath: join(root, "store.sqlite"),
  clock: () => clockNow,
});
const actor = { role: "human", sessionId: null } as const;
const agent = { role: "agent", sessionId: "library-agent" } as const;
storage.artifacts.registerSession({ id: agent.sessionId, label: "Design agent" });
const signal = storage.artifacts.createProject({ name: "Signal" });
const atlas = storage.artifacts.createProject({ name: "Atlas" });
const notes = storage.artifacts.create({
  kind: "files",
  actor,
  projectId: signal.id,
  title: "Onboarding experience",
});
const publish = (text: string, expectedSeq: number) =>
  storage.artifacts.publish(notes.id, {
    actor,
    expectedSeq,
    publicationKey: `notes-${expectedSeq}`,
    summary: expectedSeq ? "Refined navigation and empty states" : "Initial layout exploration",
    content: {
      kind: "files",
      files: [
        {
          path: "design.txt",
          mediaType: "text/plain",
          base64: Buffer.from(text).toString("base64"),
        },
      ],
    },
  });
await publish(
  Array.from({ length: 120 }, (_, i) =>
    i === 80 ? "Keyboard focus needs a visible outline." : `Design detail ${i + 1}`,
  ).join("\n"),
  0,
);
await publish("The workspace has a clear next step.\nThe primary action is now visible.", 1);
const note = await storage.conversations.add(notes.id, {
  actor,
  body: "Keyboard focus feedback",
  target: {
    kind: "source",
    versionSeq: 1,
    path: "design.txt",
    locator: { start: 81, end: 81, quote: "Keyboard focus needs a visible outline." },
  },
});
const reply = await storage.conversations.addReply(note.id, {
  actor: agent,
  body: "Keyboard focus is fixed in version 2.",
  context: { versionSeq: 2, representation: "source" },
});
for (let i = 0; i < 4; i++)
  await storage.conversations.addReply(note.id, {
    actor: agent,
    body: `Another follow-up ${i + 1}`,
    context: { versionSeq: 2, representation: "source" },
  });
const archivedIds: string[] = [];
for (let i = 0; i < 14; i++) {
  const artifact = storage.artifacts.create({
    kind: "files",
    actor,
    projectId: i % 2 ? signal.id : atlas.id,
    title: [
      "Storage usage notes",
      "Keyboard navigation fixes",
      "Component workshop",
      "Release checklist",
      "Library design",
      "Project overview",
      "Empty state proposals",
    ][i % 7],
  });
  await storage.artifacts.publish(artifact.id, {
    actor,
    expectedSeq: 0,
    publicationKey: "first",
    summary: "Published notes and conversations for the next iteration",
    content: {
      kind: "files",
      files: [
        {
          path: "notes.txt",
          mediaType: "text/plain",
          base64: Buffer.from("Review the published work.").toString("base64"),
        },
      ],
    },
  });
  if (i > 11) {
    await storage.conversations.add(artifact.id, {
      actor: agent,
      body: "Please review this published work.",
      target: { kind: "artifact" },
    });
    storage.lifecycle.transition(artifact.id, {
      actor,
      event: "archived",
      operationKey: "archive",
    });
    archivedIds.push(artifact.id);
  }
}
const preview = new PreviewHost(storage.artifacts, undefined, previewSupport);
const token = randomBytes(32).toString("base64url");
const api = createArtifactApi(
  storage,
  {
    token,
    requireLogin: false,
    version: "acceptance",
    allowedHost: (host) => host === "localhost",
  },
  { previews: preview },
);
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith(PREVIEW_PREFIX)) return preview.fetch(request);
    if (path.startsWith("/api/")) return api.app.fetch(request);
    const asset = assets.get(path.slice(1));
    if (asset) return new Response(asset);
    return new Response(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/${css}"></head><body><div id="root"></div><script type="module" src="/${js}"></script></body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
let browser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
try {
  browser = await openTestBrowser();
  const errors: string[] = [];
  browser.listen((event) => {
    if (event.method === "Runtime.exceptionThrown") errors.push(event.params.exceptionDetails.text);
  });
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const origin = `http://localhost:${server.port}`;
  const ready = () =>
    eventually(
      () => page.evaluate("document.querySelectorAll('[data-library-row]').length > 0"),
      "library rows",
    );
  const click = (selector: string) =>
    page.evaluate(`void document.querySelector(${JSON.stringify(selector)})?.click()`);
  const input = (selector: string, value: string) =>
    page.evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
  const select = (selector: string, value: string) =>
    page.evaluate(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
  const screenshot = async (name: string) => {
    if (!process.env.R3_TEST_SCREENSHOTS) return;
    await Bun.sleep(250);
    await mkdir(process.env.R3_TEST_SCREENSHOTS, { recursive: true });
    const shot = await page.command("Page.captureScreenshot", { format: "png" });
    await Bun.write(
      join(process.env.R3_TEST_SCREENSHOTS, `${name}.png`),
      Buffer.from(shot.data, "base64"),
    );
  };
  const noOverflow = async () =>
    assert.ok(
      await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
      "no horizontal overflow",
    );
  await page.command("Page.navigate", { url: origin });
  await ready();
  assert.equal(await page.evaluate("document.querySelectorAll('[data-library-row]').length"), 15);
  const groupIds = (name: string) =>
    page.evaluate<string[]>(`(() => {
      let group = '';
      const ids = [];
      for (const child of document.querySelector('section[aria-label="Artifacts"]').children) {
        if (child.tagName === 'H2') group = child.textContent;
        const row = child.matches('[data-library-row]') ? child : child.querySelector('[data-library-row]');
        if (group === ${JSON.stringify(name)} && row) ids.push(new URL(row.href).pathname.slice(1));
      }
      return ids;
    })()`);
  assert.deepEqual(await groupIds("Needs your review"), [notes.id]);
  assert.deepEqual(new Set(await groupIds("Archived")), new Set(archivedIds));
  for (const id of archivedIds) assert.equal(storage.artifacts.get(id).unhandledCount, 1);
  const transition = async (event: "archived" | "restored") => {
    const response = await fetch(`${origin}/api/artifacts/${notes.id}/lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ actor, event, operationKey: `library-${event}` }),
    });
    assert.equal(response.status, 200);
  };
  await transition("archived");
  await eventually(
    async () => (await groupIds("Needs your review")).length === 0,
    "archiving removes the artifact from review attention",
  );
  assert.ok((await groupIds("Archived")).includes(notes.id));
  assert.equal(storage.artifacts.get(notes.id).unhandledCount, 1);
  await transition("restored");
  await eventually(
    async () => (await groupIds("Needs your review")).includes(notes.id),
    "restoring returns the artifact to review attention",
  );
  const height = await page.evaluate(
    "document.querySelector('[data-library-row]').getBoundingClientRect().height",
  );
  assert.ok(height >= 52 && height <= 82, `compact rows retain spacing (${height}px)`);
  await screenshot("library-desktop");
  await noOverflow();
  const selectionToggle = '[aria-controls="library-selection-actions"]';
  const selectionState = () =>
    page.evaluate(`(() => {
      const toolbar = document.querySelector('#library-selection-actions');
      const checkbox = document.querySelector('section input[type="checkbox"]');
      return {
        active: document.querySelector('${selectionToggle}').getAttribute('aria-pressed') === 'true',
        toolbarHeight: toolbar.getBoundingClientRect().height,
        checkboxWidth: checkbox.parentElement.parentElement.getBoundingClientRect().width,
        inert: !!checkbox.closest('[inert]'),
        checked: document.querySelectorAll('section input:checked').length,
      };
    })()`);
  assert.deepEqual(await selectionState(), {
    active: false,
    toolbarHeight: 0,
    checkboxWidth: 0,
    inert: true,
    checked: 0,
  });
  assert.equal(
    await page.evaluate(`(() => {
      const kind = document.querySelector('[aria-label="Artifact kind"]');
      return kind.parentElement.querySelector('[role="status"]')?.textContent;
    })()`),
    "15 artifacts",
  );
  // Sample actual geometry to check that both controls animate on their first reveal.
  const reveal = await page.evaluate(`new Promise(resolve => {
    const samples = [];
    const start = performance.now();
    document.querySelector('${selectionToggle}').click();
    function frame() {
      samples.push({
        width: document.querySelector('section input[type="checkbox"]').parentElement.parentElement.getBoundingClientRect().width,
        height: document.querySelector('#library-selection-actions').getBoundingClientRect().height,
      });
      if (performance.now() - start < 300) requestAnimationFrame(frame);
      else resolve(samples);
    }
    requestAnimationFrame(frame);
  })`);
  const expanded = await selectionState();
  assert.ok(expanded.active && !expanded.inert && expanded.toolbarHeight > 0);
  assert.ok(
    reveal.some(
      (sample: { width: number }) => sample.width > 0 && sample.width < expanded.checkboxWidth,
    ),
  );
  assert.ok(
    reveal.some(
      (sample: { height: number }) => sample.height > 0 && sample.height < expanded.toolbarHeight,
    ),
  );
  await click('section input[type="checkbox"]');
  assert.equal((await selectionState()).checked, 1);
  await screenshot("library-selection-desktop");
  await page.evaluate(`document.querySelector('${selectionToggle}').focus()`);
  await page.command("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space" });
  await page.command("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space" });
  assert.ok((await selectionState()).inert, "exiting immediately disables hidden controls");
  await eventually(async () => (await selectionState()).checkboxWidth === 0, "selection exit");
  assert.equal((await selectionState()).toolbarHeight, 0);
  assert.equal((await selectionState()).checked, 0, "leaving selection mode clears selection");
  assert.ok(
    await page.evaluate(`(() => {
    const checkbox = document.querySelector('section input[type="checkbox"]');
    checkbox.focus();
    return document.activeElement !== checkbox;
  })()`),
    "hidden checkboxes cannot receive focus",
  );
  const libraryGeometry = () =>
    page.evaluate(`(() => {
      const pane = document.querySelector('[data-library-pane]');
      const content = pane.firstElementChild.getBoundingClientRect();
      const input = pane.querySelector('input[type="search"]').getBoundingClientRect();
      return {
        overflowing: pane.scrollHeight > pane.clientHeight,
        width: pane.clientWidth,
        contentLeft: content.left,
        contentWidth: content.width,
        inputLeft: input.left,
        inputWidth: input.width,
      };
    })()`);
  const { overflowing, ...fullGeometry } = await libraryGeometry();
  assert.equal(overflowing, true, "full library scrolls");
  await select('[aria-label="Library view"]', "attention");
  await eventually(
    () => page.evaluate("document.querySelectorAll('[data-library-row]').length===1"),
    "short library",
  );
  const { overflowing: shortOverflow, ...shortGeometry } = await libraryGeometry();
  assert.equal(shortOverflow, false, "filtered library does not scroll");
  assert.deepEqual(shortGeometry, fullGeometry, "scrollbar changes preserve content alignment");
  await select('[aria-label="Library view"]', "all");
  await eventually(
    () => page.evaluate("document.querySelectorAll('[data-library-row]').length===15"),
    "full library restored",
  );
  await page.evaluate("document.documentElement.classList.add('dark')");
  await screenshot("library-dark");
  await page.evaluate("document.documentElement.classList.remove('dark')");
  await input('input[type="search"]', "Keyboard");
  await eventually(
    () =>
      page.evaluate(
        "document.querySelector('[aria-label=\"Search results\"]')?.textContent.includes('Keyboard focus is fixed')",
      ),
    "conversation search",
  );
  assert.equal(
    await page.evaluate(
      "[...document.querySelectorAll('[data-library-row]')].some(a=>a.href.includes('line=81'))",
    ),
    false,
    "latest-only excludes older content",
  );
  await select('[aria-label="Publications to search"]', "all");
  await eventually(
    () => page.evaluate("!!document.querySelector('[data-library-row][href*=\"line=81\"]')"),
    "historical source result",
  );
  await screenshot("search-desktop");
  await click('[data-library-row][href*="line=81"]');
  await eventually(
    () => page.evaluate("!!document.querySelector('[data-line=\"81\"]')"),
    "source match mounted",
  );
  assert.ok(
    await page.evaluate("location.search.includes('version=1')"),
    "historical version is pinned",
  );
  await screenshot("workspace-desktop");
  await click('[data-app-header] a[title="Artifact library"]');
  await ready();
  assert.equal(
    await page.evaluate("document.querySelector('input[type=search]').value"),
    "Keyboard",
  );
  assert.equal(
    await page.evaluate("document.querySelector('[aria-label=\"Publications to search\"]').value"),
    "all",
  );
  await eventually(
    () =>
      page.evaluate(`!!document.querySelector('[data-library-row][href*="reply=${reply.id}"]')`),
    "reply result",
  );
  await click(`[data-library-row][href*="reply=${reply.id}"]`);
  await eventually(
    () => page.evaluate(`!!document.querySelector('[data-artifact-reply="${reply.id}"]')`),
    "earlier reply expanded",
  );
  assert.ok(
    await page.evaluate("location.search.includes('version=2')"),
    "reply uses its own version context",
  );
  await page.evaluate("history.back()");
  await ready();
  assert.equal(
    await page.evaluate("document.querySelector('input[type=search]').value"),
    "Keyboard",
  );
  await input('input[type="search"]', "NothingMatchesThis");
  await eventually(
    () => page.evaluate("document.body.textContent.includes('No matches found')"),
    "empty search",
  );
  await click('[aria-label="Clear search"]');
  await ready();
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await select('[aria-label="Project"]', signal.id);
  await select('[aria-label="Library view"]', "attention");
  await eventually(
    () => page.evaluate("document.querySelectorAll('[data-library-row]').length===1"),
    "mobile combined filters",
  );
  await screenshot("library-mobile");
  await noOverflow();
  await page.command("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await click(selectionToggle);
  await eventually(async () => (await selectionState()).active, "mobile selection mode");
  assert.ok(
    await page.evaluate(`(() => {
    const checkbox = document.querySelector('section input[type="checkbox"]');
    const toolbar = document.querySelector('#library-selection-actions').firstElementChild;
    return getComputedStyle(checkbox.parentElement.parentElement).transitionProperty === 'none'
      && getComputedStyle(toolbar).transitionProperty === 'none';
  })()`),
    "reduced motion disables selection transitions",
  );
  await click('[aria-label="Select all artifacts on this page"]');
  assert.equal((await selectionState()).checked, 1);
  await screenshot("library-selection-mobile");
  await noOverflow();
  await click(selectionToggle);
  await page.command("Emulation.setEmulatedMedia", { features: [] });
  await click("[data-library-row]");
  await eventually(
    () => page.evaluate("!!document.querySelector('[aria-label=\"Published version\"]')"),
    "mobile artifact",
  );
  await noOverflow();
  await screenshot("workspace-mobile");
  await click('[data-app-header] a[title="Artifact library"]');
  await ready();
  assert.equal(
    await page.evaluate("document.querySelector('[aria-label=\"Project\"]').value"),
    signal.id,
  );
  assert.equal(
    await page.evaluate("document.querySelector('[aria-label=\"Library view\"]').value"),
    "attention",
  );
  // Exercise usage and destructive controls against this test store only.
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.command("Page.navigate", { url: origin });
  await ready();
  const clickText = (text: string, within = "body") =>
    page.evaluate(
      `(() => { const root = document.querySelector(${JSON.stringify(within)}); const button = [...root.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!button) throw new Error('Missing action'); button.click(); })()`,
    );
  await click('[aria-label="Usage statistics"]');
  await eventually(
    () =>
      page.evaluate(
        `!!document.querySelector('[role="dialog"][aria-label="Usage statistics"] table')`,
      ),
    "usage table",
  );
  assert.equal(
    await page.evaluate(
      `document.querySelectorAll('[role="dialog"][aria-label="Usage statistics"] tbody tr').length`,
    ),
    14,
  );
  assert.ok(
    await page.evaluate(
      `document.querySelector('[role="dialog"][aria-label="Usage statistics"]').textContent.includes(${JSON.stringify(storage.usage.timezone)})`,
    ),
  );
  await screenshot("usage-desktop");
  await clickText("Last 4 weeks");
  await eventually(
    () =>
      page.evaluate(
        `document.querySelectorAll('[role="dialog"][aria-label="Usage statistics"] tbody tr').length === 4`,
      ),
    "weekly usage",
  );
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await noOverflow();
  await screenshot("usage-mobile");
  await click('[aria-label="Close statistics"]');
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 1280,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const batch = ["Batch design", "Batch prototype"].map((title) =>
    storage.artifacts.create({ kind: "files", actor, title }),
  );
  await page.command("Page.navigate", { url: origin });
  await ready();
  await click(selectionToggle);
  await eventually(async () => (await selectionState()).checkboxWidth > 0, "bulk selection mode");
  for (const item of batch) await click(`[aria-label="Select ${item.title}"]`);
  await clickText("Archive selected");
  await eventually(
    () => page.evaluate('!!document.querySelector("dialog[open]")'),
    "bulk archive confirmation",
  );
  await clickText("Archive artifacts", "dialog[open]");
  await eventually(
    async () => batch.every((item) => storage.artifacts.get(item.id).state === "archived"),
    "bulk archive committed",
  );
  await eventually(
    () => page.evaluate('!document.querySelector("dialog[open]")'),
    "bulk archive finished",
  );
  for (const item of batch) await click(`[aria-label="Select ${item.title}"]`);
  await clickText("Delete selected");
  await eventually(
    () => page.evaluate('!!document.querySelector("dialog[open]")'),
    "bulk delete confirmation",
  );
  await screenshot("bulk-delete");
  await clickText("Delete artifacts", "dialog[open]");
  await eventually(
    async () => batch.every((item) => !storage.artifacts.list().some((a) => a.id === item.id)),
    "bulk delete committed",
  );
  await eventually(
    () => page.evaluate('!document.querySelector("dialog[open]")'),
    "bulk delete finished",
  );
  const single = storage.artifacts.create({ kind: "files", actor, title: "Delete one artifact" });
  await page.command("Page.navigate", { url: `${origin}/${single.id}` });
  await eventually(
    () => page.evaluate(`!!document.querySelector('[aria-label="Artifact details and actions"]')`),
    "artifact details",
  );
  await click('[aria-label="Artifact details and actions"]');
  await clickText("Delete artifact");
  await eventually(
    () => page.evaluate('!!document.querySelector("dialog[open]")'),
    "single delete confirmation",
  );
  await clickText("Delete artifact", "dialog[open]");
  await ready();
  assert.ok(!storage.artifacts.list().some((a) => a.id === single.id));
  clockNow = new Date(Date.now() - 31 * 86400000).toISOString();
  const expired = storage.artifacts.create({ kind: "files", actor, title: "Expired archive" });
  storage.lifecycle.transition(expired.id, { actor, event: "archived", operationKey: "expire" });
  clockNow = new Date().toISOString();
  await click('[title="Settings"]');
  await clickText("Clean up archived artifacts");
  await eventually(
    () =>
      page.evaluate(
        'document.querySelector("dialog[open]")?.textContent.includes("Expired archive")',
      ),
    "GC preview",
  );
  await screenshot("gc-preview");
  assert.ok(storage.artifacts.list().some((a) => a.id === expired.id));
  await clickText("Delete eligible artifacts", "dialog[open]");
  await eventually(
    () =>
      page.evaluate('document.querySelector("dialog[open]")?.textContent.includes("Deleted 1")'),
    "GC result",
  );
  assert.ok(!storage.artifacts.list().some((a) => a.id === expired.id));
  assert.equal(storage.artifacts.get(notes.id).state, "active");
  await clickText("Done", "dialog[open]");
  assert.deepEqual(errors, []);
  console.log(
    "Library browser acceptance passed: compact rows, desktop/dark/mobile, animated selection mode, keyboard toggle, inert hidden controls, reduced motion, archive-aware review attention, history, source locations, earlier replies, pinned versions, return filters, empty search, usage windows, bulk archive/delete, single delete, and confirmed GC.",
  );
} finally {
  await browser?.close();
  api.close();
  preview.close();
  await server.stop(true);
  storage.close();
  await rm(root, { recursive: true, force: true });
}
