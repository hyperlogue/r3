import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import { PreviewHost } from "../server/preview-host.ts";
import { previewSupport } from "../server/preview-support.ts";
import { eventually, openTestBrowser } from "./browser.ts";

const root = await mkdtemp(join(tmpdir(), "r3-preview-acceptance-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human" as const, sessionId: null };
let preview: PreviewHost;
const requests: string[] = [];
const resourceServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    requests.push(new URL(request.url).pathname);
    return preview.fetch(request);
  },
});
preview = new PreviewHost(
  storage.artifacts,
  `http://localhost:${resourceServer.port}`,
  previewSupport,
);
const artifact = storage.artifacts.create({ kind: "html", actor });
const files: Record<string, [string, string]> = {
  "index.html": [
    "text/html",
    '<!doctype html><html><head><title>Preview fixture</title><script>window.activations=0;addEventListener("click",()=>window.activations++,true)</script></head><body><h1 id="heading">Published heading</h1><p id="repeated">First <b>same quote</b> between <em>same quote</em> last.</p><button id="action">Page action</button><canvas width="20" height="20"></canvas><script type="module">import r3 from "/r3/utility.js";window.r3=r3;window.fixtureData=await(await fetch("data.json")).json();r3.subscribe(()=>window.changed=(window.changed||0)+1)</script></body></html>',
  ],
  "data.json": ["application/json", '{"retained":true}'],
};
await storage.artifacts.publish(artifact.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "fixture",
  content: {
    kind: "html",
    files: Object.entries(files).map(([path, [mediaType, source]]) => ({
      path,
      mediaType,
      base64: Buffer.from(source).toString("base64"),
    })),
  },
});
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const context = preview.create(artifact.id, 1, "index.html", new URL(request.url).origin);
    return new Response(
      `<!doctype html><body style="margin:0"><iframe style="border:0;width:100vw;height:100vh" sandbox="allow-scripts allow-same-origin allow-forms" allow="camera *; microphone *"></iframe><script>
  const context=${JSON.stringify(context)};window.messages=[];const frame=document.querySelector('iframe');
  window.send=(data)=>frame.contentWindow.postMessage({contextId:context.id,...data},context.origin);
  addEventListener('message',event=>{if(event.source!==frame.contentWindow||event.origin!==context.origin)return;const message=event.data;messages.push(message);
    if(message.type==='r3-preview-gate'&&message.state==='ready')frame.src=context.documentUrl;
    if(message.type==='r3-preview-call')send({type:'r3-preview-result',id:message.id,value:{method:message.method,path:message.path}});
  });frame.src=context.gateUrl;</script>`,
      { headers: { "content-type": "text/html", "cache-control": "no-store" } },
    );
  },
});
let browser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
try {
  browser = await openTestBrowser();
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  await page.command("Page.navigate", { url: `http://localhost:${app.port}/` });
  const gate = await eventually(
    () => page.evaluate("window.messages?.find(m=>m.type==='r3-preview-gate')"),
    "isolation gate",
  );
  if (process.env.R3_TEST_UNSUPPORTED === "1") {
    assert.equal(gate.state, "unsupported");
    assert.equal(
      requests.some((path) => path.startsWith("/files/")),
      false,
    );
    console.log("Preview acceptance: unsupported browser refused before any published file");
  } else {
    assert.equal(gate.state, "ready");
    await eventually(
      () => page.evaluate("window.messages.find(m=>m.type==='r3-preview-document')"),
      "rendered document runtime",
    );
    const content = await eventually(async () => {
      const context = [...page.contexts.values()].find(
        (item) => item.origin.includes(".localhost:") && item.auxData?.isDefault,
      );
      if (context) return page.inContext(context.id);
      const frame = (await browser!.send("Target.getTargets")).targetInfos.find(
        (item: any) => item.type === "iframe" && item.url.includes("/files/index.html"),
      );
      return frame ? browser!.attach(frame.targetId) : null;
    }, "isolated frame");
    await eventually(
      () => content.evaluate("window.r3 && window.fixtureData"),
      "published module and JSON",
    );
    assert.equal(await content.evaluate("document.compatMode"), "CSS1Compat");
    assert.deepEqual(await content.evaluate("r3.getContext()"), {
      method: "getContext",
      path: "index.html",
    });
    await page.evaluate("send({type:'r3-preview-changed'})");
    await eventually(() => content.evaluate("window.changed===1"), "utility subscription");
    const display = (commenting: boolean, jump: unknown = null) =>
      page.evaluate(
        `send(${JSON.stringify({ type: "r3-preview-display", display: { commenting, targets: [], jump } })})`,
      );
    await display(true);
    await Bun.sleep(80);
    await content.evaluate("document.querySelector('#action').click()");
    assert.equal(
      await content.evaluate("window.activations"),
      0,
      "comment mode must intercept publisher capture listeners",
    );
    // CDP inspects the closed shadow root without giving publisher code access.
    await content.command("DOM.enable");
    const document = await content.command("DOM.getDocument", { depth: -1, pierce: true });
    const findButton = (node: any, label: string): any =>
      node.nodeName === "BUTTON" && node.children?.some((child: any) => child.nodeValue === label)
        ? node
        : [
            ...(node.children ?? []),
            ...(node.shadowRoots ?? []),
            ...(node.contentDocument ? [node.contentDocument] : []),
          ]
            .map((child) => findButton(child, label))
            .find(Boolean);
    const button = findButton(document.root, "Comment here");
    assert.ok(button);
    const resolved = await content.command("DOM.resolveNode", { nodeId: button.nodeId });
    await content.command("Runtime.callFunctionOn", {
      objectId: resolved.object.objectId,
      functionDeclaration: "function(){this.click()}",
    });
    const captured = await eventually(
      () => page.evaluate("messages.find(m=>m.type==='r3-preview-target')"),
      "rendered target capture",
    );
    assert.equal(captured.locator.selector, "#action");
    assert.equal(captured.locator.quote, "Page action");
    assert.ok(captured.locator.viewport.width > 0);
    await display(false, {
      nonce: 1,
      locator: { selector: "#repeated", quote: "same quote", prefix: "between", suffix: "last." },
    });
    const located = await eventually(
      () => page.evaluate("messages.find(m=>m.type==='r3-preview-located'&&m.nonce===1)"),
      "contextual repeated quote locate",
    );
    assert.equal(located.state, "anchored");
    assert.equal(
      await content.evaluate(
        "Array.from(CSS.highlights.get('r3-preview-active'))[0].startContainer.parentElement.tagName",
      ),
      "EM",
    );
    await display(false, { nonce: 2, locator: { selector: "#repeated", quote: "same quote" } });
    assert.equal(
      (
        await eventually(
          () => page.evaluate("messages.find(m=>m.type==='r3-preview-located'&&m.nonce===2)"),
          "ambiguous quote",
        )
      ).state,
      "ambiguous",
    );
    const before = await content.evaluate<number>("window.activations");
    await content.evaluate("document.querySelector('#action').click()");
    assert.equal(await content.evaluate("window.activations"), before + 1);
    assert.equal(requests.includes("/outside/check"), false);
    console.log(
      "Preview acceptance: gate, modules, utility, comment interception, native targets, quote disambiguation, and normal interaction passed",
    );
  }
} finally {
  await browser?.close();
  app.stop(true);
  resourceServer.stop(true);
  preview.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
