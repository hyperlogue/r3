import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import { PREVIEW_PREFIX, previewPolicy } from "../server/preview-contexts.ts";
import { PreviewHost } from "../server/preview-host.ts";
import { previewSupport } from "../server/preview-support.ts";
import { eventually, openTestBrowser } from "./browser.ts";

const root = await mkdtemp(join(tmpdir(), "r3-isolation-acceptance-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human" as const, sessionId: null };
const artifact = storage.artifacts.create({ kind: "html", actor });
const files: Record<string, [string, string]> = {
  "index.html": [
    "text/html",
    '<!doctype html><html><head><title>Isolation fixture</title></head><body><h1>Published fixture</h1><script type="module">import {value} from "./module.js";window.moduleValue=value</script><link rel="stylesheet" href="./style.css"><div id="styled">Styled</div><canvas width="8" height="8"></canvas></body></html>',
  ],
  "module.js": ["text/javascript", "export const value = 42;"],
  "style.css": ["text/css", "#styled{color:rgb(12,34,56)}"],
  "data.json": ["application/json", '{"version":1}'],
  "worker.js": [
    "text/javascript",
    "onmessage=async(event)=>{try{const response=await fetch(event.data);postMessage({ok:response.ok,body:await response.text()})}catch(error){postMessage({ok:false,error:error.message})}}",
  ],
  "redirect-target.txt": ["text/plain", "Must not follow redirect"],
  "pixel.svg": [
    "image/svg+xml",
    '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="blue"/></svg>',
  ],
};
const wave = Buffer.alloc(8044, 128);
wave.write("RIFF", 0);
wave.writeUInt32LE(8036, 4);
wave.write("WAVEfmt ", 8);
wave.writeUInt32LE(16, 16);
wave.writeUInt16LE(1, 20);
wave.writeUInt16LE(1, 22);
wave.writeUInt32LE(8000, 24);
wave.writeUInt32LE(8000, 28);
wave.writeUInt16LE(1, 32);
wave.writeUInt16LE(8, 34);
wave.write("data", 36);
wave.writeUInt32LE(8000, 40);
const denied: string[] = [];
const outside = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    denied.push(new URL(request.url).pathname);
    return new Response("Outside resource", {
      headers: { "access-control-allow-origin": "*", "content-type": "text/plain" },
    });
  },
});
const udp = createSocket("udp4");
await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
let packets = 0;
udp.on("message", () => packets++);
const udpPort = (udp.address() as { port: number }).port;
const preview = new PreviewHost(storage.artifacts, undefined, previewSupport);
const seen: string[] = [];
let videoRangeRequested = false;
let wrongContextRequests = 0;
let cookieRequests = 0;
let monitorIsolation = false;
async function previewRequest(request: Request) {
  const path = new URL(request.url).pathname;
  if (
    monitorIsolation &&
    !path.startsWith(new URL(context.resourceRoot).pathname.replace(/files\/$/, ""))
  )
    wrongContextRequests++;
  if (request.headers.has("cookie")) cookieRequests++;
  seen.push(path);
  if (path.endsWith("/files/clip.webm") && request.headers.has("range")) videoRangeRequested = true;
  if (path.endsWith("/r3/test-redirect")) {
    const headers = previewPolicy(preview.contexts.forRequest(request));
    headers.set("location", `${context.resourceRoot}redirect-target.txt`);
    headers.set("access-control-allow-origin", "*");
    return new Response(null, { status: 302, headers });
  }
  return preview.fetch(request);
}
let context!: ReturnType<PreviewHost["create"]>;
let sibling!: ReturnType<PreviewHost["create"]>;
const applicationRequests: string[] = [];
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith(PREVIEW_PREFIX)) return previewRequest(request);
    if (path === "/cookie-check") return Response.json({ cookie: request.headers.has("cookie") });
    if (path !== "/") {
      applicationRequests.push(path);
      return new Response("Application private data");
    }
    const origin = new URL(request.url).origin;
    context = preview.create(artifact.id, 1, "index.html", origin);
    sibling = preview.create(artifact.id, 2, "index.html", origin);
    return new Response(
      `<!doctype html><iframe sandbox="allow-scripts" credentialless></iframe><iframe sandbox="allow-scripts" credentialless></iframe><script>
      const contexts=${JSON.stringify([context, sibling])};const frames=document.querySelectorAll('iframe');const loaded=new Set();window.state='checking';
      frames.forEach((frame,i)=>{const context=contexts[i];addEventListener('message',event=>{
        if(event.source!==frame.contentWindow||event.origin!=="null"||event.data.contextId!==context.id)return;
        if(event.data.type==='r3-preview-gate'){if(event.data.state==='ready')frame.src=context.documentUrl;else window.state=event.data.state}
        if(event.data.type==='r3-preview-connect'){const port=event.ports[0];port.onmessage=event=>{if(event.data.type==='r3-preview-document'){loaded.add(context.id);if(loaded.size===2)window.state='ready'}}}
      });frame.src=context.gateUrl});</script>`,
      {
        headers: {
          "content-type": "text/html",
          "set-cookie": `r3-test-session=${crypto.randomUUID()}; Path=/; HttpOnly; SameSite=Strict`,
        },
      },
    );
  },
});
let browser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
try {
  browser = await openTestBrowser(["--use-fake-device-for-media-stream"]);
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  // Generate a tiny synthetic video with the browser's own encoder. This reads
  // no device and needs no codec download or platform-specific fixture tool.
  const videoBytes = await page.evaluate(`(async()=>{
    const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;
    const paint=canvas.getContext('2d');const stream=canvas.captureStream(20);
    const recorder=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8'});
    const chunks=[];recorder.ondataavailable=e=>chunks.push(e.data);
    const stopped=new Promise(resolve=>recorder.onstop=resolve);recorder.start(100);
    for(let i=0;i<12;i++){paint.fillStyle=i%2?'blue':'red';paint.fillRect(0,0,32,32);await new Promise(resolve=>setTimeout(resolve,50));}
    recorder.stop();await stopped;stream.getTracks().forEach(track=>track.stop());
    const bytes=new Uint8Array(await new Blob(chunks).arrayBuffer());
    return btoa(String.fromCharCode(...bytes));
  })()`);
  for (const seq of [1, 2])
    await storage.artifacts.publish(artifact.id, {
      actor,
      expectedSeq: seq - 1,
      publicationKey: `publication-${seq}`,
      content: {
        kind: "html",
        files: [
          ...Object.entries(files).map(([path, [mediaType, source]]) => ({
            path,
            mediaType,
            base64: Buffer.from(source).toString("base64"),
          })),
          { path: "tone.wav", mediaType: "audio/wav", base64: wave.toString("base64") },
          { path: "clip.webm", mediaType: "video/webm", base64: videoBytes },
        ],
      },
    });
  await page.command("Page.navigate", { url: `http://localhost:${app.port}/` });
  assert.equal(
    await eventually(
      () => page.evaluate("window.state!=='checking'&&window.state"),
      "isolation gate",
    ),
    "ready",
  );
  const frame = await eventually(async () => {
    for (const item of page.contexts.values()) {
      if (item.origin !== "://" || !item.auxData?.isDefault) continue;
      const content = page.inContext(item.id);
      try {
        if (
          await content.evaluate(
            `window.moduleValue===42 && location.href.startsWith(${JSON.stringify(context.resourceRoot)})`,
          )
        )
          return content;
      } catch {
        /* The gate document is replaced. */
      }
    }
    const target = (await browser!.send("Target.getTargets")).targetInfos.find(
      (item: any) => item.type === "iframe" && item.url.startsWith(context.resourceRoot),
    );
    if (target) {
      const content = await browser!.attach(target.targetId);
      if (
        await content.evaluate(
          `window.moduleValue===42 && location.href.startsWith(${JSON.stringify(context.resourceRoot)})`,
        )
      )
        return content;
    }
    return null;
  }, "published execution context");
  assert.equal(
    await page.evaluate("fetch('/cookie-check').then(r=>r.json()).then(r=>r.cookie)"),
    true,
  );
  monitorIsolation = true;
  assert.equal(context.origin, sibling.origin);
  assert.equal(context.origin, `http://localhost:${app.port}`);
  const base = `http://localhost:${outside.port}`;
  const appOrigin = `http://localhost:${app.port}`;
  await frame.evaluate(
    `window.testOutside=${JSON.stringify(base)};window.testApplication=${JSON.stringify(appOrigin)};window.testSibling=${JSON.stringify(sibling.resourceRoot)};window.testUdp=${udpPort};window.testRoot=${JSON.stringify(context.resourceRoot.replace(/files\/$/, ""))};`,
  );
  const supported = await frame.evaluate(
    `(async()=>({module:moduleValue,style:getComputedStyle(document.querySelector('#styled')).color,data:await(await fetch('data.json')).json(),xhr:await new Promise(resolve=>{const x=new XMLHttpRequest();x.onload=()=>resolve(JSON.parse(x.responseText));x.open('GET','data.json');x.send()}),range:await fetch('data.json',{headers:{Range:'bytes=0-3'}}).then(async r=>({status:r.status,body:await r.text()})),canvas:!!document.querySelector('canvas').getContext('2d'),secure:isSecureContext}))()`,
  );
  assert.deepEqual(supported, {
    module: 42,
    style: "rgb(12, 34, 56)",
    data: { version: 1 },
    xhr: { version: 1 },
    range: { status: 206, body: '{"ve' },
    canvas: true,
    secure: true,
  });
  const media = await frame.evaluate(
    `(async()=>{const image=new Image();image.src='pixel.svg';await image.decode();const local=new Image();local.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="3" height="3"/>');await local.decode();const audio=document.createElement('audio');audio.src='tone.wav';audio.preload='metadata';document.body.append(audio);await new Promise((resolve,reject)=>{audio.onloadedmetadata=resolve;audio.onerror=()=>reject(Error('Published audio failed'))});audio.currentTime=0.5;await new Promise((resolve,reject)=>{audio.onseeked=resolve;audio.onerror=()=>reject(Error('Published audio seek failed'))});return {image:image.naturalWidth,inline:local.naturalWidth,duration:audio.duration,position:audio.currentTime}})()`,
  );
  assert.deepEqual(media, { image: 8, inline: 3, duration: 1, position: 0.5 });
  const video = await frame.evaluate(`(async()=>{
    const video=document.createElement('video');video.muted=true;video.src='clip.webm';
    document.body.append(video);
    await new Promise((resolve,reject)=>{video.onloadeddata=resolve;video.onerror=()=>reject(Error('Published video failed'))});
    video.currentTime=0.2;
    await new Promise((resolve,reject)=>{video.onseeked=resolve;video.onerror=()=>reject(Error('Published video seek failed'))});
    return {width:video.videoWidth,height:video.videoHeight,position:video.currentTime};
  })()`);
  assert.deepEqual(video, { width: 32, height: 32, position: 0.2 });
  assert(videoRangeRequested, "Native published video must use the range resource endpoint");
  await frame.evaluate(
    `window.workerRequest=(worker,url)=>new Promise(resolve=>{worker.onmessage=e=>{worker.terminate();resolve(e.data)};worker.onerror=e=>{worker.terminate();resolve({ok:false,error:e.message})};worker.postMessage(url)})`,
  );
  const isolation = await frame.evaluate(`(async()=>{
    const denies=(read)=>{try{read();return false}catch{return true}};
    const workerBlocked=async(url)=>{try{return (await workerRequest(new Worker(url),'data.json')).ok===false}catch{return true}};
    return {
      origin:globalThis.origin,
      parent:denies(()=>parent.document.body),
      sibling:denies(()=>parent.frames[1].document.body),
      cookie:denies(()=>document.cookie),
      localStorage:denies(()=>localStorage.setItem('fixture','value')),
      sessionStorage:denies(()=>sessionStorage.setItem('fixture','value')),
      indexedDB:denies(()=>indexedDB.open('fixture')),
      worker:await workerBlocked('worker.js'),
      blobWorker:await workerBlocked(URL.createObjectURL(new Blob(['postMessage({ok:true})'],{type:'text/javascript'}))),
      serviceWorker:denies(()=>navigator.serviceWorker),
      sharedWorker:denies(()=>new SharedWorker('worker.js'))
    };
  })()`);
  assert.deepEqual(isolation, {
    origin: "null",
    parent: true,
    sibling: true,
    cookie: true,
    localStorage: true,
    sessionStorage: true,
    indexedDB: true,
    worker: true,
    blobWorker: true,
    serviceWorker: true,
    sharedWorker: true,
  });
  const blocked = await frame.evaluate(`(async()=>{
    const fails=async(url)=>{try{await fetch(url);return false}catch{return true}};
    const result={fetch:await fails(testOutside+'/fetch'),application:await fails(testApplication+'/api/boot'),sibling:await fails(testSibling+'data.json'),gate:await fails(testRoot+'r3/gate'),outsideNamespace:await fails(testRoot+'outside/check'),redirect:await fails(testRoot+'r3/test-redirect'),missing:await fetch('missing.html').then(r=>r.status),socket:await new Promise(resolve=>{try{const ws=new WebSocket(testOutside.replace('http:','ws:')+'/socket');ws.onerror=()=>resolve(true);ws.onopen=()=>{ws.close();resolve(false)}}catch{resolve(true)}})};
    result.transport=await(async()=>{try{const transport=new WebTransport('https://127.0.0.1:'+testUdp+'/transport');await transport.ready;transport.close();return false}catch{return true}})();
    result.module=await import(testOutside+'/module.js').then(()=>false,()=>true);
    const img=new Image();img.src=testOutside+'/image';document.body.append(img);
    const video=document.createElement('video');video.src=testOutside+'/video';video.load();document.body.append(video);
    const audio=document.createElement('audio');audio.src=testOutside+'/audio';audio.load();document.body.append(audio);
    const style=document.createElement('style');style.textContent='@import url('+testOutside+'/import.css);@font-face{font-family:outside;src:url('+testOutside+'/font)}body{font-family:outside;background-image:url('+testOutside+'/background)}';document.head.append(style);
    const script=document.createElement('script');script.src=testOutside+'/script';document.head.append(script);
    const link=document.createElement('link');link.rel='stylesheet';link.href=testOutside+'/style';document.head.append(link);
    const external=document.createElement('iframe');external.src=testOutside+'/frame';document.body.append(external);
    const form=document.createElement('form');form.action=testOutside+'/form';form.method='POST';document.body.append(form);form.submit();
    result.popup=window.open(testOutside+'/popup')===null;
    try{top.location=testOutside+'/parent';result.parent=false}catch{result.parent=true}
    try{navigator.sendBeacon(testOutside+'/beacon','fixture')}catch{}
    const nested=document.createElement('iframe');nested.srcdoc='<script>fetch('+JSON.stringify(testOutside+'/srcdoc-fetch')+').catch(()=>{});location='+JSON.stringify(testOutside+'/srcdoc-navigation')+'<'+ '/script>';document.body.append(nested);
    const blob=document.createElement('iframe');blob.src=URL.createObjectURL(new Blob(['<script>fetch('+JSON.stringify(testOutside+'/blob-fetch')+').catch(()=>{});location='+JSON.stringify(testOutside+'/blob-navigation')+'<'+ '/script>'],{type:'text/html'}));document.body.append(blob);
    const reopened=document.createElement('iframe');reopened.srcdoc='<script>document.open();document.write('+JSON.stringify('<script>fetch('+JSON.stringify(testOutside+'/reopened-fetch')+').catch(()=>{});location='+JSON.stringify(testOutside+'/reopened-navigation')+'<'+ '/script>')+');document.close()<'+ '/script>';document.body.append(reopened);
    return result;
  })()`);
  assert.deepEqual(blocked, {
    fetch: true,
    application: true,
    sibling: true,
    gate: true,
    outsideNamespace: true,
    redirect: true,
    missing: 404,
    socket: true,
    transport: true,
    module: true,
    popup: true,
    parent: true,
  });
  assert.equal(
    seen.some((path) => path.endsWith("/files/redirect-target.txt")),
    false,
  );
  await frame.evaluate(
    `window.testRtc=async()=>{const pc=new RTCPeerConnection({iceServers:[{urls:'stun:127.0.0.1:'+testUdp}]});pc.createDataChannel('fixture');await pc.setLocalDescription(await pc.createOffer());await new Promise(r=>setTimeout(r,300));const failed=pc.iceConnectionState==='failed';pc.close();return failed}`,
  );
  const rtc = await frame.evaluate("testRtc()");
  assert.equal(rtc, true);
  assert.equal(packets, 0);
  for (const name of ["camera", "microphone"])
    await browser.send("Browser.setPermission", {
      permission: { name },
      setting: "denied",
      origin: appOrigin,
      embeddedOrigin: context.origin,
    });
  assert.equal(
    await frame.evaluate(
      "navigator.mediaDevices.getUserMedia({video:true,audio:true}).then(s=>{s.getTracks().forEach(t=>t.stop());return 'granted'},e=>e.name)",
    ),
    "SecurityError",
  );
  for (const name of ["camera", "microphone"])
    await browser.send("Browser.setPermission", {
      permission: { name },
      setting: "granted",
      origin: appOrigin,
      embeddedOrigin: context.origin,
    });
  const devices = await frame.evaluate(
    "navigator.mediaDevices.getUserMedia({video:true,audio:true}).then(s=>{const kinds=s.getTracks().map(t=>t.kind).sort();s.getTracks().forEach(t=>t.stop());return kinds},e=>e.name)",
  );
  assert.equal(
    devices,
    "SecurityError",
    "Opaque documents cannot acquire device access even after a transport-origin grant",
  );
  assert.equal(await frame.evaluate("testRtc()"), true);
  await frame.evaluate("location=testOutside+'/document-navigation'");
  await Bun.sleep(700);
  assert.deepEqual(denied, [], "No request may reach any outside test endpoint");
  assert.equal(wrongContextRequests, 0, "Other versions must not receive preview requests");
  assert.equal(
    applicationRequests.some((path) => path === "/api/boot"),
    false,
  );
  assert.equal(packets, 0, "Device permission must not enable WebRTC network traffic");
  assert.equal(cookieRequests, 0, "Preview requests never carry the application cookie");
  console.log(
    "Preview isolation acceptance: native resources, opaque storage isolation, denied workers/devices, navigation, redirects, sockets, and WebRTC passed",
  );
} finally {
  await browser?.close();
  app.stop(true);
  outside.stop(true);
  udp.close();
  preview.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
