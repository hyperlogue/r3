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
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
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
        if (group === ${JSON.stringify(name)} && child.hasAttribute('data-library-row'))
          ids.push(new URL(child.href).pathname.slice(1));
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
  assert.deepEqual(errors, []);
  console.log(
    "Library browser acceptance passed: compact rows, desktop/dark/mobile, archive-aware review attention, history, source locations, earlier replies, pinned versions, return filters, and empty search.",
  );
} finally {
  await browser?.close();
  api.close();
  preview.close();
  await server.stop(true);
  storage.close();
  await rm(root, { recursive: true, force: true });
}
