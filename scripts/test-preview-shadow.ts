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
import { browserLoweredCssPlugin } from "./spa-css.ts";

const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "preview-workspace-fixture.tsx")],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [await browserLoweredCssPlugin()],
});
if (!build.success) throw new Error("Shadow acceptance workspace failed to build");
const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
const js = [...assets.keys()].find((path) => path.endsWith(".js"))!;
const css = [...assets.keys()].find((path) => path.endsWith(".css"));

const root = await mkdtemp(join(tmpdir(), "r3-shadow-acceptance-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human" as const, sessionId: null };
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
const artifact = storage.artifacts.create({ kind: "html", actor });
const source = `<!doctype html><html><head><script>
window.activations=0;addEventListener('click',()=>window.activations++,true);
</script></head><body>
<section id="light"><button id="inner">Light DOM control</button></section>
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
    const asset = assets.get(path.slice(1));
    if (asset) return new Response(asset);
    if (path === "/workspace")
      return new Response(
        `<!doctype html><html><head>${css ? `<link rel="stylesheet" href="/${css}">` : ""}<style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style></head><body><div id="root"></div><script type="module" src="/${js}"></script></body></html>`,
        { headers: { "content-type": "text/html", "cache-control": "no-store" } },
      );
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
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 960,
    deviceScaleFactor: 1,
    mobile: false,
  });
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
  await content.evaluate(`(() => {
    const root=document.createElement('div');root.id='deep';let node=root;
    for(let i=0;i<60;i++){const child=document.createElement('nested-'+ 'segment'.repeat(20));node.append(child);node=child}
    node.innerHTML='<button id="deep-leaf">Deep control</button>';document.body.append(root);
  })()`);
  const deep = await capture("document.querySelector('#deep-leaf')");
  assert.equal(deep.selector, "#deep-leaf");
  assert.equal(
    deep.ancestors,
    undefined,
    "oversized optional parent selectors do not invalidate a valid pick",
  );
  await content.evaluate("document.querySelector('#deep').remove()");
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
  assert.deepEqual(textLocator.ancestors?.[0], { selector: "#text", shadowDepth: 2 });

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

  const savedText = JSON.stringify(textLocator);
  await content.evaluate(`${node("second", "#text b")}.textContent='revised passage'`);
  await locate(textLocator, "ancestor");
  const shows = async (expression: string) => {
    const expected = await content.evaluate(`(${expression}).getBoundingClientRect().toJSON()`);
    await eventually(
      async () =>
        Math.abs((await ui(".box", "parseFloat(el.style.top)")) - expected.top) < 1 &&
        Math.abs((await ui(".box", "parseFloat(el.style.width)")) - expected.width) < 1,
      "nearest recorded ancestor highlight",
    );
    assert.equal(await ui(".box", "el.dataset.fallback"), "ancestor");
    assert.equal(
      await content.evaluate("CSS.highlights.has('r3-preview-active')"),
      false,
      "fallback never highlights the old quote as an exact match",
    );
  };
  await shows(node("second", "#text b"));
  await content.evaluate(`${node("second", "#text b")}.remove()`);
  await locate(textLocator, "ancestor");
  await shows(node("second", "#text"));
  assert.equal(
    await ui(".marker", "!!el"),
    false,
    "fallback does not create an exact discussion marker",
  );
  await content.evaluate(`${node("second", "#text")}.remove()`);
  await locate(textLocator, "ancestor");
  await shows("document.querySelector('#second')");
  assert.equal(JSON.stringify(textLocator), savedText, "fallback preserves the original target");
  await content.evaluate("document.querySelector('#second').remove()");
  await locate(textLocator, "unplaced");
  await content.evaluate("document.querySelector('#inner').remove()");
  await locate(plain, "ancestor");
  await shows("document.querySelector('#light')");
  content = await open();
  await content.evaluate(
    `${node("second", "#text b")}.remove();setTimeout(()=>{${node("second", "#text")}.innerHTML='A selectable <b>shadow passage</b>.'},150)`,
  );
  await locate(textLocator);
  assert.equal(
    await ui(".box", "el.dataset.fallback"),
    undefined,
    "exact matches arriving during hydration take precedence",
  );

  const legacy = { ...locator, ancestors: undefined };
  await locate({ ...legacy, shadowHosts: [".frame", "#nested"] }, "ambiguous");
  await locate({ ...legacy, shadowHosts: ["#missing", "#nested"] }, "unplaced");
  await locate({ ...legacy, shadowHosts: ["#closed"] }, "ancestor");
  await locate({ ...legacy, shadowHosts: ["[invalid"] }, "unplaced");
  await locate({ ...legacy, shadowHosts: ["[data-r3-preview]"] }, "unplaced");

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

  // The real workspace must present contextual fallback distinctly from an
  // exact match, both for Locate and the two sides of a proposed-fix comparison.
  const missingTarget = {
    kind: "rendered" as const,
    versionSeq: 1,
    path: "index.html",
    locator: {
      selector: "#missing",
      shadowHosts: ["#second", "#nested"],
      ancestors: [{ selector: "#text", shadowDepth: 2 }],
    },
  };
  const missing = await storage.conversations.add(artifact.id, {
    actor,
    body: "A missing runtime element",
    target: missingTarget,
  });
  const agent = { role: "agent" as const, sessionId: "shadow-fix-agent" };
  storage.artifacts.registerSession({ id: agent.sessionId });
  const fix = await storage.conversations.addComment(missing.id, {
    actor: agent,
    body: "A proposed shadow fix",
    target: missingTarget,
  });
  await page.command("Page.addScriptToEvaluateOnNewDocument", {
    source: "try{localStorage.setItem('r3:preview-compatibility:v1','accepted')}catch{}",
  });
  await page.command("Page.navigate", {
    url: `http://localhost:${app.port}/workspace?artifact=${artifact.id}&lang=en`,
  });
  const card = `[data-artifact-thread="${missing.id}"]`;
  await eventually(
    () => page.evaluate(`!!document.querySelector(${JSON.stringify(card)})`),
    "workspace thread",
  );
  await page.evaluate(`document.querySelector(${JSON.stringify(`${card} button`)}).click()`);
  await eventually(
    () =>
      page.evaluate(
        "document.body.textContent.includes('Exact target unavailable; showing recorded context.')",
      ),
    "explicit parent fallback notice",
  );
  await page.evaluate(`document.querySelector('[data-compare-comment="${fix.id}"]').click()`);
  await eventually(
    () =>
      page.evaluate(
        "document.querySelectorAll('[data-comparison-target-state=ancestor]').length===2",
      ),
    "comparison fallback states",
  );
  assert.equal(
    await page.evaluate(
      "Array.from(document.querySelectorAll('[data-comparison-target-state=ancestor]')).every(el=>el.textContent==='Context shown')",
    ),
    true,
  );
  console.log(
    "Shadow preview acceptance: inner picks, text, persistence, reload, nearest-parent fallback, workspace notices, comparison states, markers, isolation, and typing passed",
  );
} finally {
  await browser?.close();
  app.stop(true);
  api.close();
  preview.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
