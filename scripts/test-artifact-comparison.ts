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
  entrypoints: [join(import.meta.dir, "preview-workspace-fixture.tsx")],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [await browserLoweredCssPlugin()],
});
if (!build.success) throw new Error("Browser acceptance workspace failed to build");
const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
const js = build.outputs
  .find((output) => output.path.endsWith(".js"))!
  .path.split("/")
  .at(-1)!;
const css = build.outputs
  .find((output) => output.path.endsWith(".css"))
  ?.path.split("/")
  .at(-1);
const root = await mkdtemp(join(tmpdir(), "r3-workspace-acceptance-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human" as const, sessionId: null };
const artifact = storage.artifacts.create({ kind: "html", actor, title: "Published workspace" });
const agent = { role: "agent" as const, sessionId: "comparison-agent" };
storage.artifacts.registerSession({ id: agent.sessionId, label: "Design agent" });
const publish = (seq: number) =>
  storage.artifacts.publish(artifact.id, {
    actor,
    expectedSeq: seq - 1,
    publicationKey: `comparison-${seq}`,
    content: {
      kind: "html",
      files: [
        {
          path: "index.html",
          mediaType: "text/html",
          base64: Buffer.from(`<!doctype html><html><head><style>
  *{box-sizing:border-box}body{margin:0;padding:32px;font:16px/1.6 system-ui;background:#f7f8fa;color:#17212e}h1{font-size:32px;line-height:1.2;letter-spacing:-1px}small{color:#667085}section{padding:24px 0;border-top:1px solid #d7dce2}button{padding:12px 18px;border:0;background:#2f55cc;color:white;cursor:pointer}input{width:100%;padding:12px;border:1px solid #9da9ba}#hint{color:#647084}button:focus-visible{outline:3px solid #b488fa;outline-offset:4px}
  </style></head><body><small>WORKSPACE / PROJECTS</small><h1>${seq === 1 ? "Your next project starts here" : "Make room for your next idea"}</h1><section><h2>No projects yet</h2><p id="hint">${seq === 1 ? "Start by making a project." : "Create a project to bring files, decisions, and discussions together."}</p><button id="cta">${seq === 1 ? "Start" : "Create workspace"}</button></section><section><label>Workspace name<input id="draft" placeholder="Name your workspace"></label></section><script>window.visit=crypto.randomUUID();document.querySelector('#cta').onclick=()=>document.querySelector('#hint').textContent='Project created';</script></body></html>`).toString(
            "base64",
          ),
        },
      ],
    },
  });
await publish(1);
await publish(2);
const target = (selector: string, seq = 1) => ({
  kind: "rendered" as const,
  versionSeq: seq,
  path: "index.html",
  locator: { selector, route: "#workspace" },
});
const note = await storage.conversations.add(artifact.id, {
  actor,
  body: "Make the primary action clear and keep keyboard focus visible.",
  target: target("#cta"),
});
const fix = await storage.conversations.addComment(note.id, {
  actor: agent,
  body: "Clarified the action and added a visible keyboard focus outline.",
  context: { versionSeq: 1, representation: "rendered" },
  target: target("#cta", 2),
});
const resolved = await storage.conversations.add(artifact.id, {
  actor,
  body: "Explain how projects work.",
  target: target("#hint"),
});
await storage.conversations.addComment(resolved.id, {
  actor: agent,
  body: "Added a short explanation.",
  context: { versionSeq: 2, representation: "rendered" },
  target: target("#hint", 2),
});
storage.conversations.edit(resolved.id, { actor, status: "resolved" });
const missing = await storage.conversations.add(artifact.id, {
  actor,
  body: "This element requires unavailable application state.",
  target: target("#missing"),
});
await storage.conversations.addComment(missing.id, {
  actor: agent,
  body: "Proposed a replacement.",
  context: { versionSeq: 2, representation: "rendered" },
  target: target("#cta", 2),
});
for (const nativeTarget of [{ kind: "artifact" }, { ...target("#cta"), locator: null }]) {
  const general = await storage.conversations.add(artifact.id, {
    actor,
    body: "General design discussions",
    target: nativeTarget,
  });
  await storage.conversations.addComment(general.id, {
    actor: agent,
    body: "See this element.",
    context: { versionSeq: 2, representation: "rendered" },
    target: target("#cta", 2),
  });
}
await storage.conversations.add(artifact.id, {
  actor,
  body: "No proposed fix yet",
  target: target("#cta"),
});
const preview = new PreviewHost(storage.artifacts, previewSupport);
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
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith(PREVIEW_PREFIX)) return preview.fetch(request);
    if (path.startsWith("/api/")) return api.app.fetch(request);
    const asset = assets.get(path.slice(1));
    if (asset) return new Response(asset);
    return new Response(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">${css ? `<link rel="stylesheet" href="/${css}">` : ""}<style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style></head><body><div id="root"></div><script type="module" src="/${js}"></script></body></html>`,
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
    width: 1440,
    height: 960,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.command("Page.navigate", { url: `http://localhost:${app.port}/?version=1` });
  const read = <T = any>(js: string) => page.evaluate<T>(js);
  const click = async (selector: string) => {
    const position = await read(
      `(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e || e.disabled) throw new Error('Unavailable control: '+${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`,
    );
    await page.command("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...position,
    });
    await page.command("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...position,
    });
  };
  const button = async (label: string) => {
    const selector = await read<string>(
      `(()=>{const b=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)} && !b.closest('[inert]') && b.getBoundingClientRect().width);if(!b)throw new Error('Missing button '+${JSON.stringify(label)});b.dataset.testButton='selected';return '[data-test-button="selected"]'})()`,
    );
    await click(selector);
    await read("document.querySelector('[data-test-button]')?.removeAttribute('data-test-button')");
  };
  const wait = async (js: string, message: string) =>
    eventually(() => read(js), message).catch(async (error) => {
      console.log(
        await read(
          "JSON.stringify({url:location.search, states:[...document.querySelectorAll('[data-comparison-target-state]')].map(e=>e.outerHTML), tabs:[...document.querySelectorAll('[data-discussions-tab]')].map(e=>[e.textContent,e.getAttribute('aria-selected')])})",
        ),
      );
      await shot("comparison-failure");
      throw error;
    });
  const shot = async (name: string) => {
    await Bun.sleep(550);
    const directory = process.env.R3_TEST_SCREENSHOTS;
    if (!directory) return;
    await mkdir(directory, { recursive: true });
    const { data } = await page.command("Page.captureScreenshot", { format: "png" });
    await Bun.write(join(directory, `${name}.png`), Buffer.from(data, "base64"));
  };
  await wait(
    "document.querySelector('[data-artifact-surface] iframe')?.inert === false",
    "initial preview",
  );
  await wait(
    "document.querySelectorAll('[data-compare-comment]').length===3",
    "eligible Compare entries",
  );
  const previewFrame = await eventually(async () => {
    for (const c of page.contexts.values()) {
      if (c.origin !== "://" || !c.auxData?.isDefault) continue;
      const frame = page.inContext(c.id);
      try {
        if (await frame.evaluate("!!document.querySelector('#draft')")) return frame;
      } catch {}
    }
    return null;
  }, "original frame context");
  const visit = await previewFrame.evaluate("window.visit");
  await previewFrame.evaluate("document.querySelector('#draft').value='Keep this page state'");
  await read(
    "window.mainFrame=document.querySelector('[data-artifact-surface] iframe');window.mainPanel=document.querySelector('[aria-label=\"Artifact discussions\"]'); true",
  );
  await click('[aria-label="Float discussions"]');
  await Bun.sleep(450);
  const rect = await read(
    "(()=>{const r=document.querySelector('[data-discussions-mode]').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()",
  );
  // Prepare an ordinary draft before entering; changing panels must preserve it.
  await click('[aria-label="Add general discussions"]');
  await wait("!!document.querySelector('[data-discussions-draft] textarea')", "draft input");
  await wait(
    "document.activeElement === document.querySelector('[data-discussions-draft] textarea')",
    "draft focused",
  );
  await page.command("Input.insertText", { text: "Keep this unfinished note" });
  assert.equal(
    await read("document.querySelector('[data-discussions-draft] textarea').value"),
    "Keep this unfinished note",
  );
  await click(`[data-compare-comment="${fix.id}"]`);
  await wait("document.querySelector('[data-artifact-surface]').inert", "comparison entry");
  const motion = await read(
    "getComputedStyle(document.querySelector('[data-comparison-track]')).transform",
  );
  assert.notEqual(motion, "none");
  await wait(
    "document.querySelectorAll('[data-comparison-target-state=anchored]').length===2",
    "both version-specific targets located",
  );
  assert.equal(
    await read("document.querySelector('[data-discussions-mode]').dataset.discussionMode"),
    "expanded",
  );
  assert.equal(
    await read(
      "document.querySelector('[aria-label=\"Artifact discussions\"]')===window.mainPanel",
    ),
    true,
  );
  assert.equal(
    await read("document.querySelector('[data-artifact-surface] iframe')===window.mainFrame"),
    true,
  );
  assert.equal(
    await read(
      "document.querySelectorAll('[data-discussions-mode] [data-artifact-discussions]:not([hidden])').length",
    ),
    3,
  );
  assert.equal(
    await read("document.querySelector('[aria-label=\"Float discussions\"]').disabled"),
    true,
  );
  assert.equal(
    await read(
      "[...document.querySelectorAll('[aria-label=\"Hide discussions\"]')].every(b=>b.disabled)",
    ),
    true,
  );
  assert.equal(await read("new URLSearchParams(location.search).get('version')"), "1");
  await shot("comparison-desktop");
  assert.equal(await read("document.documentElement.scrollWidth > innerWidth"), false);
  await button("Stack");
  assert.equal(
    await read(
      "getComputedStyle(document.querySelector('[data-comparison-side=proposed]')).borderTopWidth",
    ),
    "1px",
  );
  await button("Side by side");
  await button("Narrow");
  await button("Targets");
  await button("Targets");
  await click('[aria-label="Focus targets"]');
  await wait(
    "document.querySelectorAll('[data-comparison-target-state=anchored]').length===2",
    "target refocus",
  );
  // Ordinary comment/resolve behavior is shared, and comment context names the fix.
  await click(`[data-artifact-discussions="${note.id}"] [data-discussions-action=comment]`);
  await wait(
    `document.activeElement === document.querySelector('[data-artifact-discussions="${note.id}"] [data-comment-to] textarea')`,
    "comment focused",
  );
  await page.command("Input.insertText", { text: "Retain this comparison comment" });
  await click('[aria-label="Return to artifact"]');
  await wait("!document.querySelector('[data-artifact-surface]').inert", "return to artifact");
  await Bun.sleep(550);
  assert.equal(
    await read("document.querySelector('[data-discussions-mode]').dataset.discussionMode"),
    "floating",
  );
  assert.deepEqual(
    await read(
      "(()=>{const r=document.querySelector('[data-discussions-mode]').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()",
    ),
    rect,
  );
  assert.equal(await previewFrame.evaluate("window.visit"), visit);
  assert.equal(
    await previewFrame.evaluate("document.querySelector('#draft').value"),
    "Keep this page state",
  );
  assert.equal(
    await read("document.querySelector('[data-discussions-draft] textarea').value"),
    "Keep this unfinished note",
  );
  assert.equal(
    await read(
      `document.querySelector('[data-artifact-discussions="${note.id}"] [data-comment-to] textarea').value`,
    ),
    "Retain this comparison comment",
  );
  assert.equal(
    await read("document.querySelectorAll('[data-artifact-discussions]:not([hidden])').length"),
    6,
  );
  await shot("comparison-return-floating");
  // Forward/Back restore comparison without repinning the main publication.
  await read("history.forward()");
  await wait(
    "document.querySelector('[data-artifact-surface]').inert",
    "history forward comparison",
  );
  await wait(
    "document.querySelectorAll('[data-comparison-target-state=anchored]').length===2",
    "history forward targets",
  );
  await publish(3);
  await wait(
    "document.body.textContent.includes('Go to the latest version')",
    "new publication announcement",
  );
  assert.equal(await read("new URLSearchParams(location.search).get('version')"), "1");
  assert.equal(
    await read(
      "document.querySelector('[data-comparison-side=proposed]').textContent.includes('v2')",
    ),
    true,
  );
  await click(`[data-artifact-discussions="${note.id}"] [data-comment-to] button[type=submit]`);
  await wait(
    `!!document.querySelector('[data-artifact-discussions="${note.id}"] [data-discussions-action=resolve]')`,
    "comment posted",
  );
  assert.equal(storage.conversations.get(note.id).comments.at(-1)?.context.versionSeq, 2);
  assert.equal(storage.conversations.get(note.id).status, "open");
  await click(`[data-artifact-discussions="${note.id}"] [data-discussions-action=resolve]`);
  await wait(
    `document.querySelector('[data-artifact-discussions="${note.id}"] [data-discussions-action=resolve]')?.textContent==='Reopen'`,
    "human resolution",
  );
  assert.equal(storage.conversations.get(note.id).status, "resolved");
  await wait(
    "!!document.querySelector('[data-comparison-target-state=unplaced]')",
    "unavailable runtime target remains explicit",
  );
  await shot("comparison-unavailable");
  await click('[aria-label="Return to artifact"]');
  await Bun.sleep(550);
  await click("[data-discussions-tab=resolved]");
  await Bun.sleep(300);
  await click(`[data-compare-comment="${fix.id}"]`);
  await wait(
    "document.querySelectorAll('[data-comparison-target-state=anchored]').length===2",
    "resolved comparison",
  );
  await shot("comparison-resolved");
  await read("document.documentElement.classList.add('dark')");
  await shot("comparison-dark");
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await wait(
    "!!document.querySelector('[data-mobile-discussions=docked]')",
    "mobile discussions dock",
  );
  const mobileBoxes = await read(
    "(()=>{const c=document.querySelector('[data-comparison-surface]').getBoundingClientRect(),p=document.querySelector('[data-mobile-discussions=docked]').getBoundingClientRect();return {bottom:c.bottom,top:p.top,overflow:document.documentElement.scrollWidth>innerWidth}})()",
  );
  assert.ok(
    mobileBoxes.bottom <= mobileBoxes.top + 1,
    "discussions must not overlay the comparison",
  );
  assert.equal(mobileBoxes.overflow, false);
  await shot("comparison-mobile");
  await button("Original");
  assert.equal(await read("document.querySelector('[data-comparison-side=proposed]').inert"), true);
  await button("Proposed fix");
  await click('[aria-label="Return to artifact"]');
  await wait(
    "!!document.querySelector('[data-mobile-discussions=sheet]')",
    "ordinary mobile sheet restored",
  );
  await click("[data-mobile-discussions-toggle]");
  await Bun.sleep(300);
  await page.command("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }],
  });
  await click(`[data-compare-comment="${fix.id}"]`);
  assert.equal(
    await read(
      "getComputedStyle(document.querySelector('[data-comparison-track]')).transitionProperty",
    ),
    "none",
  );
  console.log(
    "Comparison browser acceptance passed: native targets, retained frames/drafts, floating restoration, history, publication pinning, resolution, unavailable target, mobile dock, reduced motion.",
  );
} finally {
  await browser?.close();
  app.stop(true);
  storage.close();
  await rm(root, { recursive: true, force: true });
}
