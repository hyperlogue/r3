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
  entrypoints: [
    join(import.meta.dir, "preview-workspace-fixture.tsx"),
    join(import.meta.dir, "../web/src/screenshot.ts"),
  ],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [await browserLoweredCssPlugin()],
});
if (!build.success) throw new Error("Browser acceptance workspace failed to build");
const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
const js = build.outputs
  .find((output) => output.path.endsWith("preview-workspace-fixture.js"))!
  .path.split("/")
  .at(-1)!;
const css = build.outputs
  .find((output) => output.path.endsWith(".css"))
  ?.path.split("/")
  .at(-1);
const root = await mkdtemp(join(tmpdir(), "r3-workspace-acceptance-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human" as const, sessionId: null };
const artifact = storage.artifacts.create({
  kind: "html",
  actor,
  title: "Image discussions acceptance",
});
const source =
  '<!doctype html><html><head><title>Published fixture</title></head><body><h1 id="heading">Published first version</h1><p id="output">Ready</p><button id="send">Request revision</button><a href="other.html">Other document</a><script type="module">import r3 from "/r3/utility.js";send.onclick=async()=>{try{await r3.setTheme("dark");const note=await r3.createDiscussion({body:"Please revise this chart",locator:{selector:"#heading",quote:document.querySelector("h1").textContent}});window.lastDiscussion=note.id;output.textContent="Sent: "+note.id;}catch(error){output.textContent=error.message}};window.r3=r3;</script></body></html>';
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
const preview = new PreviewHost(storage.artifacts, previewSupport);
let failNextPost = false;
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
  idleTimeout: 60,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith(PREVIEW_PREFIX)) return preview.fetch(request);
    if (failNextPost && request.method === "POST" && path.endsWith("/discussions")) {
      failNextPost = false;
      return Response.json({ error: "Image save failed; retry" }, { status: 503 });
    }
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
  browser = await openTestBrowser([
    "--window-size=1400,1100",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--auto-accept-this-tab-capture",
    "--enable-usermedia-screen-capturing",
  ]);
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  await page.command("Emulation.clearDeviceMetricsOverride");
  await page.command("Page.navigate", { url: `http://localhost:${app.port}/?version=1` });
  const button = (label: string) =>
    `Array.from((document.querySelector('dialog[open]') || document).querySelectorAll('button')).find(b=>b.textContent.trim()===${JSON.stringify(label)} || b.getAttribute('aria-label')===${JSON.stringify(label)})`;
  const input =
    "document.querySelector('[data-artifact-composer]:not([data-comment-to]) textarea')";
  await eventually(async () => {
    await page.evaluate(`${button("Accept risk and continue")}?.click()`);
    return page.evaluate(`!!${button("Capture area")}`);
  }, "HTML capture control");
  assert(await page.evaluate(`!!${button("Capture area")}.closest('[data-preview-capture-slot]')`));
  assert(await page.evaluate(`!!${button("Capture area")}.closest('header')`));
  assert.equal(
    await page.evaluate(
      "document.querySelector('[data-preview-capture-slot]').previousElementSibling.getAttribute('aria-label')",
    ),
    "Comment mode",
  );
  await page.evaluate("document.querySelector('[aria-label=\"Add general discussions\"]').click()");
  await eventually(() => page.evaluate(`!!(${input})`), "composer");
  const paste = async (selector: string, plainText = "") =>
    page.evaluate(`(() => {
    const canvas=document.createElement('canvas'); canvas.width=160;canvas.height=90;
    const ctx=canvas.getContext('2d');ctx.fillStyle='#f05020';ctx.fillRect(0,0,160,90);ctx.fillStyle='#ffffff';ctx.fillText('Image discussions',10,30);
    return new Promise(resolve=>canvas.toBlob(blob=>{
      const data=new DataTransfer();data.items.add(new File([blob],'image.png',{type:'image/png'}));
      if (${JSON.stringify(plainText)}) data.setData('text/plain', ${JSON.stringify(plainText)});
      (${selector}).dispatchEvent(new ClipboardEvent('paste',{bubbles:true,cancelable:true,clipboardData:data}));resolve(true);
    },'image/png'));
  })()`);
  await paste(input);
  await eventually(
    () => page.evaluate("!!document.querySelector('[data-artifact-composer] img')"),
    "pasted image preview",
  );
  await page.command("Page.reload");
  await eventually(
    () => page.evaluate("!!document.querySelector('[data-artifact-composer] img')"),
    "image draft restored from IndexedDB",
  );
  assert.equal(await page.evaluate(`${input}.value`), " [image1] ");
  // File selection inserts at the retained caret; removing a middle image keeps
  // the remaining labels aligned with their ordered attachments.
  await page.evaluate(`(()=>{
    const field=${input};field.focus();field.setSelectionRange(field.value.length,field.value.length);
    const canvas=document.createElement('canvas');canvas.width=20;canvas.height=20;
    return new Promise(resolve=>canvas.toBlob(blob=>{
      const data=new DataTransfer();for(const name of ['second.png','third.png'])data.items.add(new File([blob],name,{type:'image/png'}));
      const files=field.form.querySelector('input[type=file]');files.files=data.files;files.dispatchEvent(new Event('change',{bubbles:true}));resolve(true);
    },'image/png'));
  })()`);
  await eventually(
    () => page.evaluate("document.querySelectorAll('[data-artifact-composer] img').length===3"),
    "file attachments",
  );
  assert.equal(await page.evaluate(`${input}.value`), " [image1] [image2] [image3] ");
  const removeSecond = () =>
    page.evaluate(
      "document.querySelectorAll('[data-artifact-composer] button[aria-label=\"Remove image\"]')[1].click()",
    );
  await removeSecond();
  assert.equal(await page.evaluate(`${input}.value`), " [image1]  [image2] ");
  await removeSecond();
  await page.evaluate(
    `(()=>{const field=${input};Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,' [image1] ');field.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  const editorCanvas = "document.querySelector('dialog[open] canvas')";
  const openEditor = async () => {
    await page.evaluate(`${button("Edit image")}.click()`);
    await eventually(
      () => page.evaluate(`${editorCanvas}?.width === 160`),
      "editable image bitmap",
    );
  };
  const draw = async (tool: string, color: string, points: [number, number][]) => {
    await page.evaluate(
      `(()=>{${button(tool)}.click();const color=document.querySelector('[aria-label="Drawing color"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(color,${JSON.stringify(color)});color.dispatchEvent(new Event('input',{bubbles:true}));color.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    const rect = await page.evaluate(
      `(()=>{const c=${editorCanvas};const r=c.getBoundingClientRect();return {x:r.x+c.clientLeft,y:r.y+c.clientTop,sx:c.clientWidth/c.width,sy:c.clientHeight/c.height}})()`,
    );
    const screen = ([x, y]: [number, number]) => ({
      x: rect.x + x * rect.sx,
      y: rect.y + y * rect.sy,
    });
    await page.command("Input.dispatchMouseEvent", {
      type: "mousePressed",
      button: "left",
      clickCount: 1,
      ...screen(points[0]!),
    });
    for (const point of points.slice(1))
      await page.command("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        button: "left",
        buttons: 1,
        ...screen(point),
      });
    await page.command("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      button: "left",
      clickCount: 1,
      ...screen(points.at(-1)!),
    });
  };
  const previewPixels = () => page.evaluate(`${editorCanvas}.toDataURL()`);
  const sample = (x: number, y: number) =>
    page.evaluate(`Array.from(${editorCanvas}.getContext('2d').getImageData(${x},${y},1,1).data)`);
  await openEditor();
  const originalPixels = await previewPixels();
  await draw("Pen", "#0000ff", [
    [10, 75],
    [70, 75],
  ]);
  assert.notEqual(await previewPixels(), originalPixels);
  await page.evaluate(`${button("Cancel")}.click()`);
  await openEditor();
  assert.equal(await previewPixels(), originalPixels, "cancel preserves the original draft image");
  await draw("Arrow", "#0000ff", [
    [10, 50],
    [80, 50],
  ]);
  assert.deepEqual(await sample(40, 50), [0, 0, 255, 255]);
  await draw("Rectangle", "#00ff00", [
    [100, 15],
    [145, 65],
  ]);
  assert.deepEqual(await sample(100, 40), [0, 255, 0, 255]);
  await page.evaluate(
    `(()=>{const select=document.querySelector('[aria-label="Stroke width"]');select.value='8';select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await draw("Pen", "#8000ff", [
    [10, 75],
    [40, 65],
    [70, 75],
  ]);
  const annotatedPixels = await previewPixels();
  await page.command("Input.dispatchKeyEvent", {
    type: "keyDown",
    key: "z",
    code: "KeyZ",
    modifiers: 2,
  });
  await page.command("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: "z",
    code: "KeyZ",
    modifiers: 2,
  });
  assert.notEqual(await previewPixels(), annotatedPixels);
  await page.evaluate(`${button("Redo")}.click()`);
  assert.equal(await previewPixels(), annotatedPixels);
  await page.evaluate(`${button("Clear drawings")}.click()`);
  assert.equal(await previewPixels(), originalPixels);
  await page.evaluate(`${button("Undo")}.click()`);
  assert.equal(await previewPixels(), annotatedPixels, "clearing drawings is undoable");
  await page.evaluate(`${button("Undo")}.click()`);
  await draw("Pen", "#8000ff", [
    [10, 75],
    [40, 65],
    [70, 75],
  ]);
  assert.equal(
    await page.evaluate(`${button("Redo")}.disabled`),
    true,
    "new drawing discards undone branch",
  );
  await page.evaluate(`${button("Use image")}.click()`);
  await eventually(
    () => page.evaluate("!document.querySelector('dialog[open]')"),
    "flattened drawings in draft",
  );
  // Reopen the saved draft in the actual phone layout and exercise touch input.
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await eventually(
    () =>
      page.evaluate(
        "innerWidth === 390 && !!Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('· 0 open'))",
      ),
    "phone discussions sheet",
  );
  await page.evaluate(
    "Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('· 0 open')).click();document.documentElement.classList.add('dark')",
  );
  await openEditor();
  assert.equal(await previewPixels(), annotatedPixels);
  await page.evaluate(`${button("Pen")}.click()`);
  const touch = await page.evaluate(
    `(()=>{const c=${editorCanvas};const r=c.getBoundingClientRect();return {x:r.x+c.clientLeft+120*c.clientWidth/c.width,y:r.y+c.clientTop+75*c.clientHeight/c.height}})()`,
  );
  await page.command("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ ...touch, id: 1 }],
  });
  await page.command("Input.dispatchTouchEvent", {
    type: "touchMove",
    touchPoints: [{ ...touch, x: touch.x + 10, id: 1 }],
  });
  await page.command("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  assert.notEqual(await previewPixels(), annotatedPixels, "touch draws in the phone editor");
  assert.equal(
    await page.evaluate(
      "document.querySelector('dialog[open]').scrollWidth <= document.querySelector('dialog[open]').clientWidth",
    ),
    true,
  );
  if (process.env.R3_TEST_IMAGE_OUTPUT) {
    const screenshot = await page.command("Page.captureScreenshot", { format: "png" });
    await Bun.write(
      join(process.env.R3_TEST_IMAGE_OUTPUT, "image-editor-mobile.png"),
      Buffer.from(screenshot.data, "base64"),
    );
  }
  await page.evaluate(`${button("Cancel")}.click()`);
  await page.command("Emulation.clearDeviceMetricsOverride");
  await page.evaluate("document.documentElement.classList.remove('dark')");
  await eventually(
    () =>
      page.evaluate(
        "innerWidth === 1400 && !!document.querySelector('[data-artifact-composer] img')",
      ),
    "desktop draft after phone editing",
  );
  failNextPost = true;
  await page.evaluate(`${input}.form.requestSubmit()`);
  await eventually(
    () =>
      page.evaluate(
        "document.querySelector('[data-artifact-composer] [role=alert]')?.textContent.includes('retry')",
      ),
    "failed image save",
  );
  assert.equal(storage.conversations.list(artifact.id).length, 0);
  await page.evaluate(`${input}.form.requestSubmit()`);
  await eventually(
    () =>
      page.evaluate(
        "!!document.querySelector('[data-artifact-discussions] img') && !document.querySelector('[data-artifact-composer]')",
      ),
    "image-only note saved",
  );
  const note = storage.conversations.list(artifact.id)[0]!;
  assert.equal(note.comments[0]!.body, " [image1] ");
  assert.equal(note.comments[0]!.attachments?.length, 1);
  assert.equal(note.comments[0]!.attachments![0]!.width, 160);
  const drawnImage = await storage.artifacts.attachments.read(
    artifact.id,
    note.comments[0]!.attachments![0]!.id,
  );
  const savedPixels = await page.evaluate(
    `(async()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(drawnImage.bytes.toString("base64"))}),x=>x.charCodeAt(0));const image=await createImageBitmap(new Blob([bytes],{type:'image/png'}));const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);image.close();return [[40,50],[100,40],[40,65]].map(([x,y])=>Array.from(ctx.getImageData(x,y,1,1).data));})()`,
  );
  assert.deepEqual(
    savedPixels,
    [
      [0, 0, 255, 255],
      [0, 255, 0, 255],
      [128, 0, 255, 255],
    ],
    "posted PNG contains flattened arrow, rectangle and pen",
  );
  await page.evaluate(
    "document.querySelector('[data-artifact-discussions] [data-discussions-action=comment]').click()",
  );
  const commentInput = "document.querySelector('[data-comment-to] textarea')";
  // Opening a comment moves the caret on the next animation frame. Wait for that
  // focus before simulating the user's text and cursor placement.
  await eventually(
    () => page.evaluate(`!!(${commentInput}) && document.activeElement === ${commentInput}`),
    "focused comment composer",
  );
  assert.equal(
    await page.evaluate(
      "!!document.querySelector('[data-comment-to] [data-discussions-action=resolve], [data-comment-to] [aria-label=\"More actions\"]')",
    ),
    false,
  );
  assert(
    await page.evaluate(
      "document.querySelector('[data-comment-to] button[title]')?.title.includes('paste an image directly')",
    ),
  );
  await page.evaluate(
    `(()=>{const field=${commentInput};Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'Beforeafter');field.dispatchEvent(new Event('input',{bubbles:true}));field.focus();field.setSelectionRange(6,6)})()`,
  );
  await page.evaluate(
    "window.originalImageDecode=window.createImageBitmap;window.createImageBitmap=(blob)=>new Promise((resolve,reject)=>{window.releaseImageDecode=()=>window.originalImageDecode(blob).then(resolve,reject)})",
  );
  await paste(commentInput, " caption");
  assert.equal(await page.evaluate(`${commentInput}.value`), "Before caption [image1] after");
  assert.equal(await page.evaluate(`${commentInput}.selectionStart`), 24);
  await page.command("Input.insertText", { text: "detail " });
  await eventually(
    () => page.evaluate("typeof window.releaseImageDecode === 'function'"),
    "pending image decode",
  );
  await page.evaluate(
    "window.createImageBitmap=window.originalImageDecode;window.releaseImageDecode()",
  );
  await eventually(
    () => page.evaluate("!!document.querySelector('[data-comment-to] img')"),
    "comment image preview",
  );
  assert.equal(
    await page.evaluate(`${commentInput}.value`),
    "Before caption [image1] detail after",
  );
  await page.evaluate(`${commentInput}.form.requestSubmit()`);
  await eventually(
    () => Promise.resolve(storage.conversations.get(note.id).comments.slice(1).length === 1),
    "image comment saved",
  );
  assert.equal(storage.conversations.get(note.id).comments.slice(1)[0]!.attachments?.length, 1);
  // The trusted parent's display capture uses a real tab stream, never a fake image.
  await page.evaluate(
    `window.captureTracks=[];const native=navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getDisplayMedia=async options=>{const stream=await native(options);window.captureTracks.push(...stream.getTracks());return stream;}`,
  );
  await eventually(
    () => page.evaluate("!document.querySelector('[data-comment-to]')"),
    "comment save completes",
  );
  await eventually(
    () => page.evaluate(`!!${button("Capture area")} && !${button("Capture area")}.disabled`),
    "ready capture control after comment",
  );
  await page.command("Page.bringToFront");
  // Ensure a real compositor paint before the headless chooser auto-accepts.
  await page.command("Page.captureScreenshot", { format: "png" });
  const clicked = await page.command("Runtime.evaluate", {
    expression: `${button("Capture area")}.click()`,
    userGesture: true,
  });
  assert(!clicked.exceptionDetails, JSON.stringify(clicked.exceptionDetails));
  await eventually(
    () => page.evaluate("!!document.querySelector('dialog[open] [aria-label=\"Crop width\"]')"),
    "captured preview crop editor",
  );
  assert(
    await page.evaluate(
      "window.captureTracks.length > 0 && window.captureTracks.every(track=>track.readyState==='ended')",
    ),
  );
  const capturedSize = await page.evaluate(
    "(()=>{const canvas=document.querySelector('dialog[open] canvas');const frame=document.querySelector('iframe');return {width:canvas.width,height:canvas.height,previewWidth:frame.clientWidth,previewHeight:frame.clientHeight}})()",
  );
  assert(
    capturedSize.width <= capturedSize.previewWidth + 2 &&
      capturedSize.height <= capturedSize.previewHeight + 2,
    "capture excludes workspace pixels outside the preview",
  );
  const setNumber = async (label: string, value: string) => {
    await page.evaluate(
      `document.querySelector('[aria-label=${JSON.stringify(label)}]').focus();document.querySelector('[aria-label=${JSON.stringify(label)}]').select()`,
    );
    await page.command("Input.insertText", { text: value });
  };
  await draw("Rectangle", "#ef4444", [
    [20, 20],
    [80, 60],
  ]);
  await setNumber("Crop x", "10");
  await setNumber("Crop y", "10");
  await setNumber("Crop width", "100");
  await setNumber("Crop height", "80");
  await page.evaluate(`${button("Use image")}.click()`);
  await eventually(
    () => page.evaluate("!!document.querySelector('[data-artifact-composer] img')"),
    "captured image in native draft",
  );
  await page.evaluate(`${input}.form.requestSubmit()`);
  await eventually(
    () => Promise.resolve(storage.conversations.list(artifact.id).length === 2),
    "screenshot saved",
  );
  const screenshot = storage.conversations.list(artifact.id)[1]!;
  assert.equal(screenshot.comments[0]!.body, " [image1] ");
  assert.equal(screenshot.target.kind, "rendered");
  assert.equal(screenshot.comments[0]!.attachments![0]!.width, 100);
  assert.equal(screenshot.comments[0]!.attachments![0]!.height, 80);
  assert.equal(screenshot.comments[0]!.attachments![0]!.capture?.versionSeq, 1);
  assert.equal(screenshot.comments[0]!.attachments![0]!.capture?.crop.x, 10);
  assert.equal(screenshot.comments[0]!.attachments![0]!.capture?.crop.y, 10);
  const cropped = await storage.artifacts.attachments.read(
    artifact.id,
    screenshot.comments[0]!.attachments![0]!.id,
  );
  const croppedPixel = await page.evaluate(
    `(async()=>{const bytes=Uint8Array.from(atob(${JSON.stringify(cropped.bytes.toString("base64"))}),x=>x.charCodeAt(0));const image=await createImageBitmap(new Blob([bytes],{type:'image/png'}));const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);image.close();return Array.from(ctx.getImageData(10,30,1,1).data);})()`,
  );
  assert.deepEqual(
    croppedPixel,
    [239, 68, 68, 255],
    "crop translates drawings into exported pixel coordinates",
  );
  const previewPage = await eventually(async () => {
    const targets = await browser!.send("Target.getTargets");
    const target = targets.targetInfos.find(
      (item: { type: string; url: string }) =>
        item.type === "iframe" && item.url.includes(PREVIEW_PREFIX),
    );
    return target ? browser!.attach(target.targetId) : null;
  }, "isolated preview target");
  const threads = await previewPage.evaluate("window.r3.getThreads()");
  assert(
    threads.every(
      (thread: {
        attachments?: unknown;
        comments: {
          attachments?: unknown;
        }[];
      }) => !thread.attachments && thread.comments.every((comment) => !comment.attachments),
    ),
  );
  const cancelled = await page.evaluate(`(async () => {
    const { capturePreview } = await import('/screenshot.js');
    const original = navigator.mediaDevices.getDisplayMedia;
    const originalImageCapture = window.ImageCapture;
    const element = document.querySelector('iframe');
    const source = document.createElement('canvas');source.width=32;source.height=32;
    let stream=source.captureStream(0);let track=stream.getVideoTracks()[0];
    const prepareTrack=()=>{track.getSettings=()=>({displaySurface:'browser'});track.cropTo=()=>new Promise(()=>{});};prepareTrack();
    const reason = async promise => { try { await promise; return 'unexpected success'; } catch (error) { return error.name || error.message; } };
    try {
      navigator.mediaDevices.getDisplayMedia = () => Promise.reject(new DOMException('Denied', 'NotAllowedError'));
      const denied = await reason(capturePreview(element, new AbortController().signal));
      let grant;
      navigator.mediaDevices.getDisplayMedia = () => new Promise(resolve => {grant=resolve});
      const controller = new AbortController();
      const pending = reason(capturePreview(element, controller.signal));
      controller.abort();
      const aborted = await pending;
      const locked = await reason(capturePreview(element, new AbortController().signal));
      grant(stream);
      await Promise.resolve(); await Promise.resolve();
      const lateStopped = track.readyState === 'ended';
      stream=source.captureStream(0);track=stream.getVideoTracks()[0];prepareTrack();
      navigator.mediaDevices.getDisplayMedia = () => Promise.resolve(stream);
      const cropping = new AbortController();
      const stalled = reason(capturePreview(element, cropping.signal));
      await new Promise(resolve=>setTimeout(resolve,50));
      cropping.abort();
      const cropAborted = await stalled;
      const cropStopped=track.readyState === 'ended';
      stream=source.captureStream(0);track=stream.getVideoTracks()[0];prepareTrack();track.cropTo=()=>Promise.resolve();
      let attempts=0, prompts=0;
      window.ImageCapture=class {grabFrame(){attempts++;return attempts===1 ? Promise.reject(undefined) : createImageBitmap(source)}};
      navigator.mediaDevices.getDisplayMedia=()=>{prompts++;return Promise.resolve(stream)};
      const retried=await capturePreview(element,new AbortController().signal);
      return {denied, aborted, locked, lateStopped, cropAborted, cropStopped, attempts, prompts, retryType:retried.type, retryStopped:track.readyState==='ended'};
    } finally { navigator.mediaDevices.getDisplayMedia = original; window.ImageCapture=originalImageCapture; }
  })()`);
  assert.equal(cancelled.denied, "NotAllowedError");
  assert.equal(cancelled.aborted, "AbortError");
  assert.equal(cancelled.locked, "Error");
  assert.equal(cancelled.lateStopped, true);
  assert.equal(cancelled.cropAborted, "AbortError");
  assert.equal(cancelled.cropStopped, true);
  assert.equal(cancelled.attempts, 2);
  assert.equal(cancelled.prompts, 1);
  assert.equal(cancelled.retryType, "image/png");
  assert.equal(cancelled.retryStopped, true);
  // A compact photo can become an oversized lossless PNG. Queue both imports,
  // cancel one, then accept only the exact resized preview of the other.
  await page.evaluate("document.querySelector('[aria-label=\"Add general discussions\"]').click()");
  await eventually(() => page.evaluate(`!!(${input})`), "optimization composer");
  const photoBytes = await page.evaluate(`(async()=>{
    const canvas=document.createElement('canvas');canvas.width=1600;canvas.height=1200;
    const ctx=canvas.getContext('2d');const pixels=ctx.createImageData(1600,1200);let seed=123;
    for(let i=0;i<pixels.data.length;i+=4){for(let c=0;c<3;c++){seed=(Math.imul(seed,1664525)+1013904223)>>>0;pixels.data[i+c]=seed>>>24;}pixels.data[i+3]=255;}
    ctx.putImageData(pixels,0,0);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.8));
    const data=new DataTransfer();for(const name of ['first.jpg','second.jpg'])data.items.add(new File([blob],name,{type:'image/jpeg'}));
    const files=(${input}).form.querySelector('input[type=file]');files.files=data.files;files.dispatchEvent(new Event('change',{bubbles:true}));return blob.size;
  })()`);
  assert(photoBytes < 5 * 1024 * 1024);
  await eventually(
    () =>
      page.evaluate(
        "document.querySelector('[aria-label=\"Image optimization\"] [role=status]')?.textContent.includes('Above 5 MiB')",
      ),
    "oversized normalization opens optimization preview",
  );
  assert(await page.evaluate(`${button("Use optimized image")}.disabled`));
  await page.evaluate(`${button("Cancel")}.click()`);
  await eventually(
    () =>
      page.evaluate(
        "document.querySelector('[aria-label=\"Image optimization\"] [role=status]')?.textContent.includes('Above 5 MiB')",
      ),
    "second queued optimization",
  );
  assert.equal(await page.evaluate(`${input}.value.trim()`), "[image1]");
  await page.evaluate(
    `(()=>{const slider=document.querySelector('[aria-label="Image size percent"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(slider,'50');slider.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  assert(
    await page.evaluate(`${button("Use optimized image")}.disabled`),
    "cannot accept a stale preview",
  );
  await eventually(
    () =>
      page.evaluate(
        `!${button("Use optimized image")}.disabled && document.querySelector('img[alt="Optimized attachment preview"]')?.naturalWidth === 800`,
      ),
    "resized PNG preview ready",
  );
  await page.evaluate(`${button("View actual pixels")}.click()`);
  assert.equal(
    await page.evaluate(
      "document.querySelector('img[alt=\"Optimized attachment preview\"]').clientWidth",
    ),
    800,
  );
  const previewHash = await page.evaluate(`(async()=>{
    const bytes=await (await fetch(document.querySelector('img[alt="Optimized attachment preview"]').src)).arrayBuffer();
    const hash=await crypto.subtle.digest('SHA-256',bytes);return Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join('');
  })()`);
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  assert(
    await page.evaluate(
      "document.querySelector('dialog[open]').scrollWidth <= document.querySelector('dialog[open]').clientWidth",
    ),
  );
  if (process.env.R3_TEST_IMAGE_OUTPUT) {
    const screenshot = await page.command("Page.captureScreenshot", { format: "png" });
    await Bun.write(
      join(process.env.R3_TEST_IMAGE_OUTPUT, "image-optimization-mobile.png"),
      Buffer.from(screenshot.data, "base64"),
    );
  }
  await page.evaluate(`${button("Use optimized image")}.click()`);
  await eventually(
    () => page.evaluate("!document.querySelector('dialog[open]')"),
    "accepted optimization",
  );
  await page.command("Emulation.clearDeviceMetricsOverride");
  await eventually(
    () =>
      page.evaluate("document.querySelector('[data-artifact-composer] img')?.naturalWidth === 800"),
    "accepted optimization saved in draft",
  );
  await page.command("Page.reload");
  await eventually(
    () =>
      page.evaluate("document.querySelector('[data-artifact-composer] img')?.naturalWidth === 800"),
    "optimized draft survives reload",
  );
  await page.evaluate(`${input}.form.requestSubmit()`);
  await eventually(
    () => Promise.resolve(storage.conversations.list(artifact.id).length === 3),
    "optimized discussions posted",
  );
  const optimized = storage.conversations.list(artifact.id)[2]!.comments[0]!.attachments![0]!;
  assert.equal(optimized.width, 800);
  assert.equal(optimized.height, 600);
  assert.equal(optimized.mediaType, "image/png");
  assert.equal(optimized.hash, previewHash, "posted bytes match the accepted preview");
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  assert.equal(await page.evaluate("document.documentElement.scrollWidth <= innerWidth"), true);
  console.log(
    "Discussion images: paste, reload, retry, comment, real tab capture, crop, drawing, undo/redo, optimization preview, exact saved bytes, cancellation, scoped bridge, and narrow layout passed",
  );
} finally {
  await browser?.close();
  app.stop(true);
  api.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
