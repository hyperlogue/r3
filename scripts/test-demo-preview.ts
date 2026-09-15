// Build first with R3_DEMO_BASE=/r3/demo bun run build:demo. This serves only
// those static outputs and uses a fresh Chromium profile; no daemon is involved.
import assert from "node:assert/strict";
import { resolve, sep } from "node:path";
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
      for (const context of page.contexts.values()) {
        if (!context.auxData?.isDefault) continue;
        const frame = page.inContext(context.id);
        try {
          if (
            await frame.evaluate(
              `parent!==window && document.body?.textContent.includes(${JSON.stringify(text)})`,
            )
          )
            return frame;
        } catch {
          /* Navigation can retire a context while enumerating it. */
        }
      }
      return null;
    }, `bundled preview: ${text}`);
  const clickButton = (text: string) =>
    page.evaluate(
      `void [...document.querySelectorAll('button')].find(b=>b.textContent.trim().startsWith(${JSON.stringify(text)}))?.click()`,
    );
  await open("artifact_weekend?version=1");
  let frame = await preview("5 min read");
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
  await frame.evaluate("void document.querySelector('#pack').click()");
  assert(
    await frame.evaluate("document.querySelector('#packed').textContent.includes('Picnic added')"),
  );
  await frame.evaluate("void document.querySelector('a').click()");
  frame = await preview("The small things.");
  await frame.evaluate("void document.querySelector('a').click()");
  frame = await preview("5 min read");
  // Select real rendered text with trusted pointer input, then save through the
  // normal composer. The resulting native target must remain pinned to v1.
  await frame.evaluate(
    "void document.querySelector('#reading-time').scrollIntoView({block:'center'})",
  );
  const offset = await page.evaluate(
    "(()=>{const r=document.querySelector('iframe').getBoundingClientRect();return {x:r.x,y:r.y}})()",
  );
  const text = await frame.evaluate(
    "(()=>{const range=document.createRange();range.selectNodeContents(document.querySelector('#reading-time'));const r=range.getBoundingClientRect();return {x:r.x,y:r.y+r.height/2,width:r.width}})()",
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
    x: offset.x + text.x + text.width,
    y: offset.y + text.y,
  });
  await page.command("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    button: "left",
    clickCount: 1,
    x: offset.x + text.x + text.width,
    y: offset.y + text.y,
  });
  await eventually(
    () => page.evaluate("!!document.querySelector('textarea[aria-label=\"Feedback\"]')"),
    "rendered selection composer",
  );
  await page.evaluate("void document.querySelector('textarea[aria-label=\"Feedback\"]').focus()");
  await page.command("Input.insertText", { text: "Please correct the reading estimate." });
  await page.evaluate(
    "void document.querySelector('textarea[aria-label=\"Feedback\"]').form.requestSubmit()",
  );
  const readNote =
    "JSON.parse(localStorage.getItem('r3-artifact-demo')).artifacts.find(a=>a.id==='artifact_weekend').feedback.find(n=>n.body==='Please correct the reading estimate.')";
  const note = await eventually(() => page.evaluate(readNote), "saved native feedback");
  assert.equal(note.target.kind, "rendered");
  assert.equal(note.target.versionSeq, 1);
  assert.equal(note.target.path, "index.html");
  assert.equal(note.target.locator.quote, "5 min read");
  await clickButton("Send to agent");
  await eventually(
    () => page.evaluate(`(${readNote})?.replies.length === 1`),
    "scripted agent reply",
  );
  assert.equal(await page.evaluate(`(${readNote}).status`), "open", "agent replies do not resolve");
  assert(
    await frame.evaluate("document.querySelector('#reading-time').textContent==='5 min read'"),
  );
  await clickButton("Go to the latest version");
  await preview("10 min read");
  await page.command("Page.reload");
  await preview("10 min read");
  assert.equal((await page.evaluate(readNote)).target.versionSeq, 1);
  // Pick an element through the shared runtime's closed-shadow controls and
  // return to its native document using Locate after navigating elsewhere.
  frame = await preview("10 min read");
  await frame.evaluate("void document.querySelector('a').click()");
  frame = await preview("The small things.");
  await page.evaluate("void document.querySelector('[aria-label=\"Comment mode\"]').click()");
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
  await page.command("DOM.enable");
  const control = await eventually(async () => {
    const { root } = await page.command("DOM.getDocument", { depth: -1, pierce: true });
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
      return (await page.command("DOM.getBoxModel", { nodeId: node.nodeId })).model.content;
    } catch {
      return null;
    }
  }, "rendered element comment control");
  for (const type of ["mousePressed", "mouseReleased"])
    await page.command("Input.dispatchMouseEvent", {
      type,
      button: "left",
      clickCount: 1,
      x: (control[0] + control[2]) / 2,
      y: (control[1] + control[5]) / 2,
    });
  await eventually(
    () => page.evaluate("!!document.querySelector('textarea[aria-label=\"Feedback\"]')"),
    "element composer",
  );
  await page.evaluate("void document.querySelector('textarea[aria-label=\"Feedback\"]').focus()");
  await page.command("Input.insertText", { text: "Keep this checklist heading." });
  await page.evaluate(
    "void document.querySelector('textarea[aria-label=\"Feedback\"]').form.requestSubmit()",
  );
  const elementNote = await eventually(
    () =>
      page.evaluate(
        "JSON.parse(localStorage.getItem('r3-artifact-demo')).artifacts.find(a=>a.id==='artifact_weekend').feedback.find(n=>n.body==='Keep this checklist heading.')",
      ),
    "saved element feedback",
  );
  assert.equal(elementNote.target.path, "details.html");
  assert.equal(elementNote.target.locator.quote, "The small things.");
  assert.equal(elementNote.target.locator.route, "#checklist");
  await page.evaluate("void document.querySelector('[aria-label=\"Exit comment mode\"]').click()");
  await frame.evaluate("void document.querySelector('a').click()");
  await preview("10 min read");
  await page.evaluate(
    `void document.querySelector('[data-artifact-feedback="${elementNote.id}"] button[title]').click()`,
  );
  await preview("The small things.");
  await page.evaluate(
    `void document.querySelector('[data-artifact-feedback="${elementNote.id}"] [data-feedback-action="resolve"]').click()`,
  );
  await eventually(
    () =>
      page.evaluate(
        `JSON.parse(localStorage.getItem('r3-artifact-demo')).artifacts.find(a=>a.id==='artifact_weekend').feedback.find(n=>n.id==='${elementNote.id}').status==='resolved'`,
      ),
    "human resolution",
  );
  await open("artifact_weekend?version=2&file=index.html");
  // A tampered local-storage document cannot replace the trusted bundled bytes.
  await page.evaluate(
    "(()=>{const s=JSON.parse(localStorage.getItem('r3-artifact-demo'));s.publications['artifact_weekend/2'].resources['index.html']=btoa('<h1>Stored replacement</h1>');localStorage.setItem('r3-artifact-demo',JSON.stringify(s))})()",
  );
  await page.command("Page.reload");
  await preview("10 min read");
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
  console.log(
    "Static demo previews passed: scoped bytes, opaque sandbox, CSP, HTML navigation, native selection, agent/version loop, Markdown height/cache/theme, narrow layout, Pages reload",
  );
} finally {
  await browser?.close();
  server.stop(true);
}
