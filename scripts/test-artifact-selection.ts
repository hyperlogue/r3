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
const root = await mkdtemp(join(tmpdir(), "r3-selection-acceptance-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human" as const, sessionId: null };
const artifact = storage.artifacts.create({ kind: "html", actor, title: "Selection workspace" });
const source =
  '<!doctype html><html><head><title>Published fixture</title></head><body><h1 id="heading">Published first version</h1><p id="output">Ready</p><p id="selection-text">A second selectable paragraph for quoting.</p><input id="input" value="Editable input"><div id="editor" contenteditable>Editable region</div><button id="send">Request revision</button><a href="other.html">Other document</a><script type="module">import r3 from "/r3/utility.js";send.onclick=async()=>{try{await r3.setTheme("dark");const note=await r3.createFeedback({body:"Please revise this chart",locator:{selector:"#heading",quote:document.querySelector("h1").textContent}});window.lastFeedback=note.id;output.textContent="Sent: "+note.id;}catch(error){output.textContent=error.message}};window.r3=r3;</script></body></html>';
for (const seq of [1, 2])
  await storage.artifacts.publish(artifact.id, {
    actor,
    expectedSeq: seq - 1,
    publicationKey: `publication-${seq}`,
    content: {
      kind: "html",
      files: [
        {
          path: "index.html",
          mediaType: "text/html",
          base64: Buffer.from(
            seq === 1 ? source : source.replace("first version", "second version"),
          ).toString("base64"),
        },
        {
          path: "other.html",
          mediaType: "text/html",
          base64: Buffer.from(
            '<!doctype html><h1>Other published document</h1><a href="index.html">Back</a>',
          ).toString("base64"),
        },
      ],
    },
  });
const files = storage.artifacts.create({ kind: "files", actor, title: "Selection files" });
await storage.artifacts.publish(files.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "files",
  content: {
    kind: "files",
    files: [
      {
        path: "index.md",
        mediaType: "text/markdown",
        base64: Buffer.from(
          "# Published Markdown\n\nA selectable Markdown paragraph.\n\nAnother paragraph for quoting.",
        ).toString("base64"),
      },
    ],
  },
});
const diff = storage.artifacts.create({ kind: "diff", actor, title: "Selection diff" });
await storage.artifacts.publish(diff.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "diff",
  content: {
    kind: "diff",
    patch:
      "diff --git a/code.ts b/code.ts\n--- a/code.ts\n+++ b/code.ts\n@@ -1 +1 @@\n-const before = true;\n+const after = true;\n",
  },
});
storage.artifacts.registerSession({ id: "selection-agent", harness: "acceptance" });
const thread = await storage.conversations.add(artifact.id, {
  actor,
  body: "Discuss this passage",
  target: { kind: "artifact" },
});
await storage.conversations.addReply(thread.id, {
  actor: { role: "agent", sessionId: "selection-agent" },
  body: "An agent reply that can be quoted.",
  context: { versionSeq: 1, representation: "rendered" },
});
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
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith(PREVIEW_PREFIX)) return preview.fetch(request);
    if (path.startsWith("/api/")) return api.app.fetch(request);
    const asset = assets.get(path.slice(1));
    if (asset) return new Response(asset);
    return new Response(
      `<!doctype html><html><head>${css ? `<link rel="stylesheet" href="/${css}">` : ""}<style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style></head><body><div id="root"></div><script type="module" src="/${js}"></script></body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
let browser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
try {
  browser = await openTestBrowser();
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  type Document = Pick<typeof page, "evaluate">;
  const key = async (key: string, code: string, modifiers = 0) => {
    await page.command("Input.dispatchKeyEvent", { type: "keyDown", key, code, modifiers });
    await page.command("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
  };
  const open = async (id: string, extra = "") => {
    await page.command("Page.navigate", {
      url: `http://localhost:${app.port}/?artifact=${id}&version=1${extra}`,
    });
    await eventually(
      () => page.evaluate("!!document.querySelector('[data-artifact-content]')"),
      "workspace",
    );
  };
  const frame = async (heading: string) =>
    eventually(async () => {
      for (const context of page.contexts.values()) {
        if (context.origin !== "://" || !context.auxData?.isDefault) continue;
        const doc = page.inContext(context.id);
        try {
          if (
            await doc.evaluate(
              `document.querySelector('h1')?.textContent === ${JSON.stringify(heading)}`,
            )
          )
            return doc;
        } catch {
          /* A replaced gate is gone. */
        }
      }
      return null;
    }, "rendered document");
  const feedbackField =
    "document.querySelector('[data-artifact-composer]:not([data-reply-to]) textarea')";
  const hasComposer = () => page.evaluate(`!!${feedbackField}`);
  const focused = () => page.evaluate(`document.activeElement === ${feedbackField}`);
  const click = async (label: string) => {
    await page.evaluate(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim() === ${JSON.stringify(label)} || b.getAttribute('aria-label') === ${JSON.stringify(label)})?.click()`,
    );
  };
  const select = async (doc: Document, selector: string, keyboard = false) => {
    // Precise native ranges and real key delivery exercise the document bridge.
    if (doc !== page) await page.evaluate("document.querySelector('iframe').focus()");
    await doc.evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(selector)});
      node.focus?.();
      const range = document.createRange(); range.selectNodeContents(node);
      if (${keyboard}) document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',shiftKey:true,bubbles:true}));
      getSelection().removeAllRanges(); getSelection().addRange(range);
      if (!${keyboard}) node.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,button:0}));
    })()`);
  };
  const waitComposer = (description: string) => eventually(hasComposer, description);
  await open(artifact.id);
  let content = await frame("Published first version");
  // Long selections and idle Escape must not depend on a transient activation timer.
  await page.evaluate("document.querySelector('iframe').focus()");
  await Bun.sleep(5200);
  await select(content, "#heading");
  await waitComposer("idle preview selection composer");
  await Bun.sleep(100);
  await key("Escape", "Escape");
  await eventually(
    () =>
      page.evaluate(
        "document.querySelector('[data-feedback-mode]').dataset.feedbackMode === 'hidden'",
      ),
    "idle Escape in the preview hides the desktop feedback panel",
  );
  assert(await hasComposer(), "hiding the panel preserves its empty preview note");
  await click("Show feedback");
  await select(content, "#selection-text");
  await waitComposer("second paragraph composer");
  await select(content, "#heading");

  assert.equal(await focused(), false, "selection must preserve native Copy focus");
  assert.equal(await content.evaluate("getSelection().toString()"), "Published first version");
  await page.evaluate("document.querySelector('iframe').focus()");
  await key(" ", "Space");
  await eventually(focused, "Space bridges from the opaque document to its composer");
  await page.command("Input.insertText", { text: "Keep this note." });
  await key("Escape", "Escape");
  assert.equal(await focused(), false);
  assert.equal(await page.evaluate(`${feedbackField}.value`), "Keep this note.");
  await key("Tab", "Tab");
  await eventually(focused, "explicit composer focus");
  await select(content, "#selection-text");
  // Inspect the trusted closed shadow root through CDP, as the artifact cannot.
  const action = async (label: string) => {
    const { root: document } = await page.command("DOM.getDocument", { depth: -1, pierce: true });
    const visit = (node: any): any => {
      if (node.attributes?.includes("hidden")) return null;
      if (
        node.nodeName === "BUTTON" &&
        node.children?.some((child: any) => child.nodeValue === label) &&
        !node.attributes?.includes("hidden")
      )
        return node;
      for (const child of [
        ...(node.children ?? []),
        ...(node.shadowRoots ?? []),
        ...(node.contentDocument ? [node.contentDocument] : []),
      ]) {
        const result = visit(child);
        if (result) return result;
      }
      return null;
    };
    return visit(document);
  };
  const tapAction = async (label: string, collapse?: Document) => {
    const node = await eventually(() => action(label), label);
    const { model } = await page.command("DOM.getBoxModel", { nodeId: node.nodeId });
    const x = (model.border[0] + model.border[2]) / 2,
      y = (model.border[1] + model.border[5]) / 2;
    await page.command("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      x,
      y,
    });
    if (collapse) {
      await collapse.evaluate("getSelection().removeAllRanges()");
      await Bun.sleep(50);
    }
    await page.command("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      x,
      y,
    });
  };
  await tapAction("Quote in note");
  await eventually(
    () => page.evaluate(`${feedbackField}.value.includes('> A second selectable paragraph')`),
    "quoted selection",
  );
  await eventually(focused, "explicit composer focus");
  assert.equal(
    await page.evaluate(
      "document.querySelector('[data-artifact-composer] blockquote').textContent",
    ),
    "Published first version",
    "quoting preserves the original target",
  );
  await click("Discard");
  await eventually(async () => !(await hasComposer()), "discard");
  await select(content, "#editor");
  await Bun.sleep(350);
  assert.equal(await hasComposer(), false, "editable HTML is excluded");
  await content.evaluate(
    "document.querySelector('#input').focus();document.querySelector('#input').select()",
  );
  await key("Tab", "Tab");
  assert.equal(await hasComposer(), false);
  await content.evaluate("document.activeElement.blur()");
  await select(content, "#heading", true);
  assert.equal(await hasComposer(), false, "keyboard capture debounces");
  await waitComposer("keyboard preview selection composer");
  await click("Cancel");
  await eventually(async () => !(await hasComposer()), "cancel");
  // The separate old action remains local to the selected agent message.
  await select(page, '[data-message-author="agent"]');
  await eventually(
    () =>
      page.evaluate(
        "Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='Quote in reply')",
      ),
    "same-thread quote action",
  );
  await click("Quote in reply");
  await eventually(
    () =>
      page.evaluate(
        "document.querySelector('[data-reply-to] textarea')?.value.includes('> An agent reply')",
      ),
    "reply quote",
  );
  assert.equal(await hasComposer(), false, "agent text does not create a new note");
  await open(files.id, "&view=source&file=index.md");
  await eventually(
    () => page.evaluate("!!document.querySelector('[data-line=\"1\"] code')"),
    "source rows",
  );
  await select(page, '[data-line="1"] code');
  await waitComposer("source selection composer");
  assert.equal(await focused(), false);
  await key("Tab", "Tab");
  await eventually(focused, "explicit composer focus");
  await click("Cancel");
  await open(diff.id, "&view=diff&file=code.ts");
  await eventually(
    () => page.evaluate("!!document.querySelector('[data-new-line=\"1\"] code')"),
    "diff rows",
  );
  await select(page, '[data-new-line="1"] code');
  await waitComposer("diff selection composer");
  assert.equal(await focused(), false);
  await click("Cancel");
  await open(files.id, "&view=rendered&file=index.md");
  content = await frame("Published Markdown");
  await select(content, "h1");
  await waitComposer("Markdown selection composer");
  assert.equal(await focused(), false);
  await key("Tab", "Tab");
  await eventually(focused, "Markdown Tab focus");
  await page.command("Input.insertText", { text: "A native Markdown target." });
  await click("Add feedback");
  await eventually(
    () =>
      Promise.resolve(
        storage.conversations
          .list(files.id)
          .some((note) => note.body === "A native Markdown target."),
      ),
    "posted Markdown feedback",
  );
  const posted = storage.conversations
    .list(files.id)
    .find((note) => note.body === "A native Markdown target.")!;
  assert.equal(posted.target.kind, "rendered");
  assert.equal("versionSeq" in posted.target && posted.target.versionSeq, 1);
  assert.equal("locator" in posted.target && posted.target.locator?.quote, "Published Markdown");
  await page.command("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await open(artifact.id);
  content = await frame("Published first version");
  await content.evaluate("getSelection().removeAllRanges()");
  await select(content, "#heading", true);
  await eventually(() => action("Add feedback"), "touch Add feedback action");
  assert.equal(await hasComposer(), false, "touch selection waits for an explicit action");
  await tapAction("Add feedback", content);
  await waitComposer("touch selection composer");
  assert.equal(await focused(), false, "touch Add feedback opens without the keyboard");
  await click("Cancel");
  await eventually(async () => !(await hasComposer()), "clear the touch draft before navigation");
  // Start node-keyboard checks in a fresh desktop document so earlier gestures
  // and the mobile sheet cannot leave focus or selection state behind.
  await page.command("Emulation.setTouchEmulationEnabled", { enabled: false });
  await page.command("Emulation.clearDeviceMetricsOverride");
  await page.command("Page.navigate", { url: "about:blank" });
  await open(artifact.id);
  content = await frame("Published first version");
  const commentMode = () =>
    page.evaluate("!!document.querySelector('[aria-label=\"Exit comment mode\"]')");
  await key("c", "KeyC");
  await eventually(commentMode, "c enables comment mode from the workspace");
  await page.command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "c",
    code: "KeyC",
    autoRepeat: true,
  });
  assert(await commentMode(), "holding c does not toggle comment mode again");
  await page.evaluate("document.querySelector('iframe').focus()");
  await content.evaluate("document.querySelector('#input').focus()");
  await key("c", "KeyC");
  assert(await commentMode(), "c belongs to the focused preview input");
  await content.evaluate("document.activeElement.blur()");
  await key("c", "KeyC");
  await eventually(async () => !(await commentMode()), "c exits comment mode from the preview");
  await key("c", "KeyC");
  await eventually(commentMode, "c enables comment mode from the preview");
  // Let the new display state reach the isolated document before picking.
  await page.evaluate(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  // A selected page button must become a native feedback target, not activate.
  await content.evaluate(
    "getSelection().removeAllRanges();document.querySelector('#send').focus();document.querySelector('#send').click()",
  );
  await eventually(() => action("Comment here"), "picked node actions");
  await page.command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: " ",
    code: "Space",
    autoRepeat: true,
  });
  assert.equal(await hasComposer(), false, "held Space does not comment on a node");
  await key(" ", "Space", 8);
  assert.equal(await hasComposer(), false, "modified Space does not comment on a node");
  await key(" ", "Space");
  await eventually(focused, "Space comments on the picked node and focuses its editor");
  assert.equal(
    await content.evaluate("window.lastFeedback"),
    undefined,
    "the page button stays inactive",
  );
  await page.command("Input.insertText", { text: "A keyboard-picked node." });
  await click("Add feedback");
  await eventually(
    () =>
      Promise.resolve(
        storage.conversations
          .list(artifact.id)
          .find((note) => note.body === "A keyboard-picked node."),
      ),
    "posted node feedback",
  );
  const nodeNote = storage.conversations
    .list(artifact.id)
    .find((note) => note.body === "A keyboard-picked node.")!;
  assert.equal(nodeNote.target.kind, "rendered");
  assert.equal("locator" in nodeNote.target && nodeNote.target.locator?.selector, "#send");
  assert.equal("locator" in nodeNote.target && nodeNote.target.locator?.quote, "Request revision");
  await eventually(async () => !(await hasComposer()), "node composer saved");
  await key("c", "KeyC");
  await eventually(async () => !(await commentMode()), "return to normal interaction");
  await content.evaluate("document.activeElement.blur();getSelection().removeAllRanges()");
  console.log(
    "Selection acceptance passed: all native views, debounce, focus, drafts, reply quotes, and touch action.",
  );
} finally {
  await browser?.close();
  app.stop(true);
  api.close();
  preview.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
