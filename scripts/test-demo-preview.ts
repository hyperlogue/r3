// Build first with R3_DEMO_BASE=/r3/demo bun run build:demo. This serves only
// those static outputs and uses a fresh Chromium profile; no daemon is involved.
import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
import { ARTIFACT_WORKSHOP_SEED } from "../web/demo/artifact-fixtures.gen.ts";
import { eventually, openTestBrowser } from "./browser.ts";

const root = resolve(import.meta.dir, "../dist/demo");
let outsideRequests = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/r3/demo/")) {
      outsideRequests++;
      return new Response(null, { status: 404 });
    }
    const file = resolve(root, path.slice("/r3/demo/".length) || "index.html");
    if (file !== root && !file.startsWith(root + sep)) return new Response(null, { status: 404 });
    return new Response(
      Bun.file((await Bun.file(file).exists()) ? file : resolve(root, "404.html")),
    );
  },
});
let browser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
try {
  browser = await openTestBrowser();
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 1365,
    height: 900,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const open = async (route: string) => {
    await page.command("Page.navigate", { url: new URL(`/r3/demo/${route}`, server.url).href });
    await eventually(
      () =>
        page
          .evaluate("!!document.querySelector('[aria-label=\"Published version\"]')")
          .then(Boolean),
      "demo workspace",
    );
    await page.evaluate(
      "void [...document.querySelectorAll('button')].find(b=>b.textContent==='Explore →')?.click()",
    );
  };
  const preview = (text: string) =>
    eventually(async () => {
      // Wait for the current document's bridge before attaching. Chromium can
      // swap the iframe process during navigation, retiring an earlier inspector.
      const ready = await page.evaluate(
        `[...document.querySelectorAll('iframe[aria-hidden="false"]')].some(frame => frame.srcdoc.includes(${JSON.stringify(text)})) && !document.querySelector('[aria-busy="true"]')`,
      );
      if (!ready) return null;
      const candidates = [...page.contexts.values()]
        .filter((context) => context.auxData?.isDefault)
        .map((context) => page.inContext(context.id));
      const { targetInfos } = await browser!.send("Target.getTargets");
      for (const target of targetInfos) {
        if (target.type !== "iframe") continue;
        try {
          candidates.push(await browser!.attach(target.targetId));
        } catch {
          /* Navigation can discard a target before attachment. */
        }
      }
      for (const frame of candidates) {
        try {
          if (
            await frame.evaluate(
              `parent!==window && document.readyState === "complete" && document.body?.textContent.includes(${JSON.stringify(text)})`,
            )
          )
            return frame;
        } catch {
          /* A process swap can retire the inspector before evaluation. */
        }
      }
      return null;
    }, `bundled preview: ${text}`);
  const clickButton = (text: string) =>
    page.evaluate(
      `void [...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(text)}))?.click()`,
    );
  await open("artifact_weekend?version=1");
  let frame = await preview("Can this model capture every ripple?");
  assert.equal(
    await page.evaluate("document.querySelector('iframe').getAttribute('sandbox')"),
    "allow-scripts",
  );
  assert(await frame.evaluate("(()=>{try{return !parent.document}catch{return true}})()"));
  assert(
    await frame.evaluate(
      "(()=>{try{localStorage.getItem('anything');return false}catch{return true}})()",
    ),
  );
  const priorRequests = outsideRequests;
  assert(
    await frame.evaluate(
      `fetch(${JSON.stringify(new URL("/denied", server.url).href)}).then(()=>false,()=>true)`,
    ),
  );
  assert.equal(outsideRequests, priorRequests, "CSP blocks an otherwise reachable request");
  const initialError = await frame.evaluate("Number(document.querySelector('#rmse').textContent)");
  const originalPath = await frame.evaluate(
    "document.querySelector('#estimate-path').getAttribute('d')",
  );
  // Exercise native range dragging and keyboard adjustment inside the opaque frame.
  await frame.evaluate(
    "void document.querySelector('#frequency').scrollIntoView({block:'center'})",
  );
  await frame.evaluate(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  const frameRect = await page.evaluate(
    "(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.x,y:r.y}})()",
  );
  const slider = await frame.evaluate(
    "(()=>{const r=document.querySelector('#frequency').getBoundingClientRect();return {x:r.x,y:r.y+r.height/2,width:r.width}})()",
  );
  await page.command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    x: frameRect.x + slider.x + slider.width * 0.35,
    y: frameRect.y + slider.y,
  });
  await page.command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    button: "left",
    buttons: 1,
    x: frameRect.x + slider.x + slider.width * 0.7,
    y: frameRect.y + slider.y,
  });
  await page.command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    x: frameRect.x + slider.x + slider.width * 0.7,
    y: frameRect.y + slider.y,
  });
  assert(
    (await frame.evaluate("document.querySelector('#estimate-path').getAttribute('d')")) !==
      originalPath,
    "dragging the frequency slider updates the curve",
  );
  assert.notEqual(
    await frame.evaluate("Number(document.querySelector('#rmse').textContent)"),
    initialError,
  );
  await frame.evaluate("void document.querySelector('#frequency').focus()");
  const beforeKey = await frame.evaluate("Number(document.querySelector('#frequency').value)");
  await page.command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
  });
  await page.command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "ArrowRight",
    code: "ArrowRight",
    windowsVirtualKeyCode: 39,
  });
  assert.equal(
    await frame.evaluate("Number(document.querySelector('#frequency').value)"),
    Number((beforeKey + 0.01).toFixed(2)),
  );
  await frame.evaluate("void document.querySelector('[data-preset=close]').click()");
  assert(
    (await frame.evaluate("Number(document.querySelector('#rmse').textContent)")) < initialError,
  );
  // With the main wave matched, the residual is exactly the omitted cosine term.
  const residuals = Array.from({ length: 401 }, (_, i) => 0.12 * Math.cos((3 * i) / 40));
  const expectedRmse = Math.sqrt(residuals.reduce((sum, e) => sum + e * e, 0) / 401).toFixed(3);
  assert.equal(await frame.evaluate("document.querySelector('#rmse').textContent"), expectedRmse);
  assert.equal(await frame.evaluate("document.querySelector('#max-error').textContent"), "0.120");
  await frame.evaluate(
    "(()=>{const p=document.querySelector('#probe');p.value='0';p.dispatchEvent(new Event('input',{bubbles:true}))})()",
  );
  assert.equal(
    await frame.evaluate("document.querySelector('#point-error').textContent"),
    "-0.120",
  );
  assert.equal(await frame.evaluate("document.querySelector('#point-truth').textContent"), "0.120");
  await frame.evaluate("void document.querySelector('#reset').click()");
  assert.equal(
    await frame.evaluate("document.querySelector('#estimate-path').getAttribute('d')"),
    originalPath,
  );
  if (process.env.R3_TEST_SCREENSHOT) {
    await frame.evaluate("window.scrollTo(0,0)");
    const shot = await page.command("Page.captureScreenshot", { format: "png" });
    await Bun.write(process.env.R3_TEST_SCREENSHOT, Buffer.from(shot.data, "base64"));
  }
  await page.evaluate("void document.documentElement.classList.add('dark')");
  await eventually(
    () => frame.evaluate("getComputedStyle(document.body).backgroundColor==='rgb(20, 32, 36)'"),
    "curve lab dark theme",
  );
  if (process.env.R3_TEST_SCREENSHOT) {
    const shot = await page.command("Page.captureScreenshot", { format: "png" });
    await Bun.write(`${process.env.R3_TEST_SCREENSHOT}.dark.png`, Buffer.from(shot.data, "base64"));
  }
  await page.evaluate("void document.documentElement.classList.remove('dark')");
  await eventually(
    () => frame.evaluate("getComputedStyle(document.body).backgroundColor==='rgb(248, 250, 249)'"),
    "curve lab light theme",
  );
  await frame.evaluate("void document.querySelector('a').click()");
  frame = await preview("Behind the curves.");
  await frame.evaluate("void document.querySelector('a').click()");
  frame = await preview("Can this model capture every ripple?");
  // Select real rendered text with trusted pointer input, then save through the
  // normal composer. The resulting native target must remain pinned to v1.
  await frame.evaluate(
    "void document.querySelector('#model-note').scrollIntoView({block:'center'})",
  );
  await frame.evaluate(
    "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  const offset = await page.evaluate(
    "(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.x,y:r.y}})()",
  );
  const text = await frame.evaluate(
    "(()=>{const range=document.createRange();range.selectNodeContents(document.querySelector('#model-note'));const r=range.getBoundingClientRect();return {x:r.x,y:r.y+r.height/2,width:r.width}})()",
  );
  await page.command("Input.dispatchMouseEvent", {
    type: "mousePressed",
    button: "left",
    clickCount: 1,
    x: offset.x + text.x,
    y: offset.y + text.y,
  });
  await page.command("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    button: "left",
    buttons: 1,
    x: offset.x + text.x + text.width - 1,
    y: offset.y + text.y,
  });
  await page.command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    x: offset.x + text.x + text.width - 1,
    y: offset.y + text.y,
  });
  await eventually(
    () => page.evaluate("!!document.querySelector('textarea[aria-label=\"Feedback\"]')"),
    "rendered selection composer",
  );
  await page.evaluate("void document.querySelector('textarea[aria-label=\"Feedback\"]').focus()");
  await page.command("Input.insertText", { text: "Explain the remaining error." });
  await page.evaluate(
    "void document.querySelector('textarea[aria-label=\"Feedback\"]').form.requestSubmit()",
  );
  const readNote =
    "JSON.parse(localStorage.getItem('r3-artifact-demo-curves')).artifacts.find(a=>a.id==='artifact_weekend').feedback.find(n=>n.body==='Explain the remaining error.')";
  const note = await eventually(() => page.evaluate(readNote), "saved native feedback");
  assert.equal(note.target.kind, "rendered");
  assert.equal(note.target.versionSeq, 1);
  assert.equal(note.target.path, "index.html");
  assert.equal(note.target.locator.quote, "Can this model capture every ripple?");
  await clickButton("Send to agent");
  await eventually(
    () => page.evaluate(`(${readNote})?.replies.length === 1`),
    "scripted agent reply",
  );
  assert.equal(await page.evaluate(`(${readNote}).status`), "open", "agent replies do not resolve");
  assert(
    await frame.evaluate(
      "document.querySelector('#model-note').textContent==='Can this model capture every ripple?'",
    ),
  );
  await clickButton("Go to the latest version");
  await preview(
    "The small cosine ripple is outside this model; a close fit still has residual error.",
  );
  await page.command("Page.reload");
  await preview(
    "The small cosine ripple is outside this model; a close fit still has residual error.",
  );
  assert.equal((await page.evaluate(readNote)).target.versionSeq, 1);
  // Pick an element through the shared runtime's closed-shadow controls and
  // return to its native document using Locate after navigating elsewhere.
  frame = await preview(
    "The small cosine ripple is outside this model; a close fit still has residual error.",
  );
  await frame.evaluate("void document.querySelector('a').click()");
  frame = await preview("Behind the curves.");
  await page.evaluate("void document.querySelector('[aria-label=\"Comment mode\"]').click()");
  await frame.evaluate(
    "document.querySelector('h1').scrollIntoView({block:'center'}); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
  );
  const frameOffset = await page.evaluate(
    "(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.x,y:r.y}})()",
  );
  const heading = await frame.evaluate(
    "(()=>{const r=document.querySelector('h1').getBoundingClientRect();return {x:r.x+20,y:r.y+r.height/2}})()",
  );
  for (const type of ["mousePressed", "mouseReleased"])
    await page.command("Input.dispatchMouseEvent", {
      type,
      button: "left",
      clickCount: 1,
      x: frameOffset.x + heading.x,
      y: frameOffset.y + heading.y,
    });
  await frame.command("DOM.enable");
  const control = await eventually(async () => {
    const { root } = await frame.command("DOM.getDocument", { depth: -1, pierce: true });
    const find = (node: any): any => {
      if (
        node.nodeName === "BUTTON" &&
        node.children?.some((child: any) => child.nodeValue === "Comment here")
      )
        return node;
      for (const child of [
        ...(node.children ?? []),
        ...(node.shadowRoots ?? []),
        ...(node.contentDocument ? [node.contentDocument] : []),
      ]) {
        const result = find(child);
        if (result) return result;
      }
      return null;
    };
    const node = find(root);
    if (!node) return null;
    try {
      return (await frame.command("DOM.getBoxModel", { nodeId: node.nodeId })).model.content;
    } catch {
      return null;
    }
  }, "rendered element comment control");
  for (const type of ["mousePressed", "mouseReleased"])
    await page.command("Input.dispatchMouseEvent", {
      type,
      button: "left",
      clickCount: 1,
      x: (control[0] + control[2]) / 2 + (frame.command === page.command ? 0 : frameOffset.x),
      y: (control[1] + control[5]) / 2 + (frame.command === page.command ? 0 : frameOffset.y),
    });
  await eventually(
    () => page.evaluate("!!document.querySelector('textarea[aria-label=\"Feedback\"]')"),
    "element composer",
  );
  await page.evaluate("void document.querySelector('textarea[aria-label=\"Feedback\"]').focus()");
  await page.command("Input.insertText", { text: "Keep this explanation heading." });
  await page.evaluate(
    "void document.querySelector('textarea[aria-label=\"Feedback\"]').form.requestSubmit()",
  );
  const elementNote = await eventually(
    () =>
      page.evaluate(
        "JSON.parse(localStorage.getItem('r3-artifact-demo-curves')).artifacts.find(a=>a.id==='artifact_weekend').feedback.find(n=>n.body==='Keep this explanation heading.')",
      ),
    "saved element feedback",
  );
  assert.equal(elementNote.target.path, "details.html");
  assert.equal(elementNote.target.locator.quote, "Behind the curves.");
  assert.equal(elementNote.target.locator.route, "#method");
  await page.evaluate("void document.querySelector('[aria-label=\"Exit comment mode\"]').click()");
  await frame.evaluate("void document.querySelector('a').click()");
  await preview(
    "The small cosine ripple is outside this model; a close fit still has residual error.",
  );
  await page.evaluate(
    `void document.querySelector('[data-artifact-feedback="${elementNote.id}"] button[title]').click()`,
  );
  await preview("Behind the curves.");
  await page.evaluate(
    `void document.querySelector('[data-artifact-feedback="${elementNote.id}"] [data-feedback-action="resolve"]').click()`,
  );
  await eventually(
    () =>
      page.evaluate(
        `JSON.parse(localStorage.getItem('r3-artifact-demo-curves')).artifacts.find(a=>a.id==='artifact_weekend').feedback.find(n=>n.id==='${elementNote.id}').status==='resolved'`,
      ),
    "human resolution",
  );
  await open("artifact_weekend?version=2&file=index.html");
  // A tampered local-storage document cannot replace the trusted bundled bytes.
  await page.evaluate(
    "(()=>{const s=JSON.parse(localStorage.getItem('r3-artifact-demo-curves'));s.publications['artifact_weekend/2'].resources['index.html']=btoa('<h1>Stored replacement</h1>');localStorage.setItem('r3-artifact-demo-curves',JSON.stringify(s))})()",
  );
  await page.command("Page.reload");
  await preview(
    "The small cosine ripple is outside this model; a close fit still has residual error.",
  );
  // The public gallery has no Files artifact. Install the development-only
  // fixture in this isolated profile for the Markdown renderer checks below.
  await page.evaluate(`(() => {
    const saved = JSON.parse(localStorage.getItem('r3-artifact-demo-curves'));
    saved.artifacts.push(${JSON.stringify(ARTIFACT_WORKSHOP_SEED.artifacts.find((item) => item.id === "artifact_documents"))});
    saved.publications['artifact_documents/1'] = ${JSON.stringify(ARTIFACT_WORKSHOP_SEED.publications["artifact_documents/1"])};
    localStorage.setItem('r3-artifact-demo-curves', JSON.stringify(saved));
  })()`);
  await open("artifact_documents?version=1&file=index.md&view=rendered");
  frame = await preview("Published workspace");
  await eventually(
    () => page.evaluate("parseInt(document.querySelector('iframe').style.height)>320"),
    "full-height Markdown",
  );
  await page.evaluate("void(window.savedPreview=document.querySelector('iframe'))");
  await page.evaluate(
    'void document.querySelector(\'[data-file="index.md"] button[title="Collapse"]\').click()',
  );
  await eventually(
    () => page.evaluate("!!document.querySelector('iframe')?.closest('[inert]')"),
    "folded retained preview",
  );
  await page.evaluate(
    'void document.querySelector(\'[data-file="index.md"] button[title="Expand"]\').click()',
  );
  assert(
    await page.evaluate("window.savedPreview===document.querySelector('iframe')"),
    "folding retains the frame",
  );
  await page.evaluate("void document.documentElement.classList.add('dark')");
  await eventually(
    () => frame.evaluate("getComputedStyle(document.body).backgroundColor==='rgb(10, 10, 10)'"),
    "Markdown dark theme",
  );
  await page.evaluate("void document.documentElement.classList.remove('dark')");
  await eventually(
    () => frame.evaluate("getComputedStyle(document.body).backgroundColor==='rgb(255, 255, 255)'"),
    "Markdown light theme",
  );
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.command("Page.reload");
  await preview("Published workspace");
  assert(
    await page.evaluate("document.documentElement.scrollWidth<=innerWidth"),
    "narrow layout does not overflow",
  );
  await open("artifact_weekend?version=2");
  frame = await preview("A little closer.");
  assert(
    await frame.evaluate("document.documentElement.scrollWidth<=innerWidth"),
    "narrow curve lab does not overflow",
  );
  await frame.evaluate("void document.querySelector('[data-preset=drift]').click()");
  assert(
    (await frame.evaluate("Number(document.querySelector('#rmse').textContent)")) >
      Number(expectedRmse),
  );
  if (process.env.R3_TEST_SCREENSHOT) {
    const shot = await page.command("Page.captureScreenshot", { format: "png" });
    await Bun.write(
      `${process.env.R3_TEST_SCREENSHOT}.narrow.png`,
      Buffer.from(shot.data, "base64"),
    );
  }
  console.log(
    "Static demo previews passed: chart controls and error metrics, scoped bytes, opaque sandbox, CSP, HTML navigation, native selection, agent/version loop, Markdown height/cache/theme, narrow layout, Pages reload",
  );
} finally {
  await browser?.close();
  server.stop(true);
}
