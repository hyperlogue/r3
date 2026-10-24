import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactApi } from "../server/artifact-api.ts";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import { PreviewHost } from "../server/preview-host.ts";
import { previewSupport } from "../server/preview-support.ts";
import type { ArtifactThread, RenderedLocator } from "../shared/artifacts.ts";
import { previewLocator } from "../web/src/preview-bridge.ts";
import { eventually, openTestBrowser } from "./browser.ts";

const root = await mkdtemp(join(tmpdir(), "r3-shadow-acceptance-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human" as const, sessionId: null };
const preview = new PreviewHost(storage.artifacts, previewSupport);
const api = createArtifactApi(storage, {
  token: randomBytes(32).toString("base64url"),
  requireLogin: false,
  version: "acceptance",
  allowedHost: (host) => host === "localhost",
});
const artifact = storage.artifacts.create({ kind: "html", actor });
const source = `<!doctype html><html><head><script>
window.activations=0;addEventListener('click',()=>window.activations++,true);
</script></head><body>
<button id="inner">Light DOM control</button>
${["first", "second"]
  .map(
    (id) => `<div id="${id}" class="frame"><template shadowrootmode="open">
  <div id="nested" style="display:contents"><template shadowrootmode="open">
    <button id="inner">Inner control</button><input id="input" value="Editable">
    <p id="text">A selectable <b>shadow passage</b>.</p>
  </template></div>
</template></div>`,
  )
  .join("")}
<div id="closed"><template shadowrootmode="closed"><button>Closed control</button></template></div>
</body></html>`;
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
        base64: Buffer.from(source).toString("base64"),
      },
    ],
  },
});
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/__r3_preview/")) return preview.fetch(request);
    if (path.startsWith("/api/")) return api.app.fetch(request);
    // This controlled fixture exercises targeting in the existing consented
    // compatibility mode. The separate isolation suites exercise admission.
    const context = preview.create(
      artifact.id,
      1,
      "index.html",
      new URL(request.url).origin,
      "compatible",
    );
    return new Response(
      `<!doctype html><body style="margin:0"><iframe style="border:0;width:100vw;height:100vh" sandbox="allow-scripts" credentialless></iframe><script>
      const context=${JSON.stringify(context)},frame=document.querySelector('iframe');window.messages=[];
      let port;window.send=data=>port.postMessage({contextId:context.id,...data});
      addEventListener('message',event=>{
        if(event.source!==frame.contentWindow||event.origin!=="null"||event.data.contextId!==context.id)return;
        if(event.data.type==='r3-preview-connect'){
          port?.close();port=event.ports[0];port.onmessage=({data})=>messages.push(data);
        }
      });frame.src=context.documentUrl;
    </script>`,
      { headers: { "content-type": "text/html", "cache-control": "no-store" } },
    );
  },
});
let browser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
try {
  browser = await openTestBrowser();
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  const open = async () => {
    await page.command("Page.navigate", { url: `http://localhost:${app.port}/` });
    await eventually(
      () => page.evaluate("window.messages?.some(m=>m.type==='r3-preview-document')"),
      "preview runtime",
    );
    return eventually(async () => {
      const context = [...page.contexts.values()].find(
        (item) => item.origin === "://" && item.auxData?.isDefault,
      );
      if (context) return page.inContext(context.id);
      const frame = (await browser!.send("Target.getTargets")).targetInfos.find(
        (item: any) => item.type === "iframe" && item.url.includes("/files/index.html"),
      );
      return frame ? browser!.attach(frame.targetId) : null;
    }, "isolated document");
  };
  let content = await open();
  const node = (id: string, selector = "#inner") =>
    `document.querySelector('#${id}').shadowRoot.querySelector('#nested').shadowRoot.querySelector(${JSON.stringify(selector)})`;
  const display = async (commenting: boolean, jump: unknown = null, targets: unknown[] = []) => {
    await page.evaluate(
      `send(${JSON.stringify({ type: "r3-preview-display", display: { commenting, targets, jump } })})`,
    );
    await content.evaluate(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
  };
  const ui = async (selector: string, expression: string) => {
    // CDP alone can inspect r3's closed shadow root; publisher code cannot.
    const { root: document } = await content.command("DOM.getDocument", {
      depth: -1,
      pierce: true,
    });
    const find = (node: any): any =>
      node.attributes?.includes("data-r3-preview")
        ? node
        : [...(node.children ?? []), ...(node.contentDocument ? [node.contentDocument] : [])]
            .map(find)
            .find(Boolean);
    const shadow = find(document)?.shadowRoots?.[0];
    assert(shadow, "trusted overlay exists");
    const resolved = await content.command("DOM.resolveNode", { nodeId: shadow.nodeId });
    const result = await content.command("Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration: `function(){const el=this.querySelector(${JSON.stringify(selector)});return ${expression}}`,
      returnByValue: true,
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result.value;
  };
  const action = (index: number) => ui(`.controls button:nth-child(${index})`, "el.click()");
  const capture = async (expression: string, parents = 0) => {
    await page.evaluate("messages=[]");
    const activations = await content.evaluate("window.activations");
    await content.evaluate(`getSelection().removeAllRanges();(${expression}).click()`);
    assert.equal(
      await content.evaluate("window.activations"),
      activations,
      "picks never activate publisher handlers",
    );
    for (let i = 0; i < parents; i++) await action(2);
    await action(1);
    const message = await eventually(
      () => page.evaluate("messages.find(m=>m.type==='r3-preview-target')"),
      "picked target",
    );
    return previewLocator(message.locator)!;
  };
  await display(true);
  await content.evaluate(
    `${node("second")}.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,composed:true}))`,
  );
  await eventually(async () => {
    const width = await content.evaluate(`${node("second")}.getBoundingClientRect().width`);
    return Math.abs((await ui(".box", "parseFloat(el.style.width)")) - width) < 1;
  }, "hover highlights the inner control");
  const captured = await capture(node("second"));
  assert.equal(captured.selector, "#inner", "pick the inner control, not its host");
  assert.equal(captured.quote, "Inner control");
  assert.deepEqual(captured.shadowHosts, ["#second", "#nested"]);
  const parent = await capture(node("second"), 1);
  assert.equal(parent.selector, "#nested");
  assert.deepEqual(parent.shadowHosts, ["#second"], "Select parent crosses the root to its host");
  const outer = await capture(node("second"), 2);
  assert.equal(outer.selector, "#second");
  assert.equal(outer.shadowHosts, undefined);
  const plain = await capture("document.querySelector('#inner')");
  assert.equal(plain.quote, "Light DOM control");
  assert.equal(plain.shadowHosts, undefined, "ordinary selectors keep their document scope");
  await display(false);
  await page.evaluate("messages=[]");
  await content.evaluate(`(() => {
    const el=${node("second", "#text b")}, range=document.createRange();
    range.selectNodeContents(el);getSelection().removeAllRanges();getSelection().addRange(range);
    el.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,composed:true,button:0}));
  })()`);
  const selection = await eventually(
    () => page.evaluate("messages.find(m=>m.type==='r3-preview-selection')"),
    "native shadow text selection",
  );
  const textLocator = previewLocator(selection.locator)!;
  assert.equal(textLocator.quote, "shadow passage");
  assert.deepEqual(textLocator.shadowHosts, ["#second", "#nested"]);

  // Store through the public contract, then read back before replacing the DOM.
  const response = await fetch(
    `http://localhost:${app.port}/api/artifacts/${artifact.id}/threads`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor,
        body: "Revise the second frame",
        target: { kind: "rendered", versionSeq: 1, path: "index.html", locator: captured },
      }),
    },
  );
  assert.equal(response.status, 201);
  const thread = (await response.json()) as ArtifactThread;
  const persisted = (await fetch(`http://localhost:${app.port}/api/threads/${thread.id}`).then(
    (response) => response.json(),
  )) as ArtifactThread;
  assert.equal(persisted.target.kind, "rendered");
  const locator = (persisted.target as { locator: RenderedLocator }).locator;
  assert.deepEqual(locator, captured);
  content = await open();
  let nonce = 0;
  const locate = async (target: RenderedLocator, state = "anchored") => {
    const current = ++nonce;
    await display(false, { locator: target, nonce: current }, [
      { threadId: thread.id, locator: target },
    ]);
    const result = await eventually(
      () => page.evaluate(`messages.find(m=>m.type==='r3-preview-located'&&m.nonce===${current})`),
      "Locate outcome",
    );
    assert.equal(result.state, state);
  };
  await locate(textLocator);
  assert.equal(
    await content.evaluate(
      `Array.from(CSS.highlights.get('r3-preview-active'))[0].startContainer.parentElement === ${node("second", "#text b")}`,
    ),
    true,
    "selected text locates inside the original shadow root",
  );
  await locate(locator);
  assert.equal(
    await content.evaluate(
      `Array.from(CSS.highlights.get('r3-preview-active'))[0].startContainer.parentElement === ${node("second")}`,
    ),
    true,
    "Locate restores the exact frame after reload",
  );
  assert.equal(
    await ui(".marker", "!!el && !el.hidden"),
    true,
    "shadow target has a discussion marker",
  );
  await content.evaluate(`${node("second")}.style.marginTop='80px'`);
  await eventually(async () => {
    const expected = await content.evaluate(`${node("second")}.getBoundingClientRect().top`);
    return Math.abs((await ui(".marker", "parseFloat(el.style.top)")) - expected) < 1;
  }, "shadow mutations reposition markers");

  await locate({ ...locator, shadowHosts: [".frame", "#nested"] }, "ambiguous");
  await locate({ ...locator, shadowHosts: ["#missing", "#nested"] }, "unplaced");
  await locate({ ...locator, shadowHosts: ["#closed"] }, "unplaced");
  await locate({ ...locator, shadowHosts: ["[invalid"] }, "unplaced");
  await locate({ ...locator, shadowHosts: ["[data-r3-preview]"] }, "unplaced");

  await display(true);
  await page.evaluate("document.querySelector('iframe').focus();messages=[]");
  await content.evaluate(`${node("second", "#input")}.focus()`);
  assert.equal(
    await content.evaluate(
      `document.querySelector('#second').shadowRoot.querySelector('#nested').shadowRoot.activeElement === ${node("second", "#input")}`,
    ),
    true,
  );
  await page.command("Input.dispatchKeyEvent", { type: "keyDown", key: "c", code: "KeyC" });
  await page.command("Input.dispatchKeyEvent", { type: "keyUp", key: "c", code: "KeyC" });
  assert.equal(
    await page.evaluate("messages.some(m=>m.type==='r3-preview-toggle-commenting')"),
    false,
    "typing in a shadow input keeps its keys",
  );
  await display(false);
  const activations = await content.evaluate("window.activations");
  await content.evaluate(`${node("second")}.click()`);
  assert.equal(
    await content.evaluate("window.activations"),
    activations + 1,
    "ordinary page clicks still work",
  );
  console.log(
    "Shadow preview acceptance: inner picks, nested parent selection, persisted targets, reload Locate, markers, ambiguity, isolation, and typing passed",
  );
} finally {
  await browser?.close();
  app.stop(true);
  api.close();
  preview.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
