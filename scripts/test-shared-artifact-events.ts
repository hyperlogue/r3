import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startArtifactServer } from "../server/artifact-server.ts";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import { eventually, openTestBrowser } from "./browser.ts";

const root = await mkdtemp(join(tmpdir(), "r3-shared-events-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "shared-artifact-events-fixture.ts")],
  target: "browser",
});
assert.ok(build.success);
const actor = { role: "human" as const, sessionId: null };
const artifact = storage.artifacts.create({ kind: "html", actor });
await storage.artifacts.publish(artifact.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "images",
  content: {
    kind: "html",
    files: [
      { path: "index.html", mediaType: "text/html", base64: btoa('<img src="image.svg">') },
      {
        path: "image.svg",
        mediaType: "image/svg+xml",
        base64: btoa('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"/>'),
      },
    ],
  },
});
const runtime = startArtifactServer({
  storage,
  assets: {
    index: {
      body: new Blob(['<!doctype html><body><script type="module" src="/fixture.js"></script>']),
      contentType: "text/html",
      etag: '"fixture"',
    },
    files: new Map([
      ["/fixture.js", { body: build.outputs[0]!, contentType: "text/javascript", etag: '"js"' }],
    ]),
  },
  authentication: {
    token: "fixture",
    requireLogin: false,
    version: "test",
    allowedHost: (host) => host === "localhost",
    applicationOrigins: new Set(),
  },
  bind: "127.0.0.1",
  port: 0,
});
const origin = `http://localhost:${runtime.server.port}`;
const preview = runtime.previews.create(artifact.id, 1, "index.html", origin);
let active = 0;
let maximum = 0;
let total = 0;
const clients = new Map<string, AbortController>();
// Count real event responses through the application API, including their cancellation.
const original = runtime.api.app.fetch.bind(runtime.api.app);
runtime.api.app.fetch = async (request, ...args) => {
  if (new URL(request.url).pathname !== "/api/events") return original(request, ...args);
  const controller = new AbortController();
  const response = await original(
    new Request(request, { signal: AbortSignal.any([request.signal, controller.signal]) }),
    ...args,
  );
  const id = new URL(request.url).searchParams.get("tab") ?? "";
  clients.set(id, controller);
  active++;
  total++;
  maximum = Math.max(maximum, active);
  const reader = response.body!.getReader();
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    active--;
    if (clients.get(id) === controller) clients.delete(id);
  };
  return new Response(
    new ReadableStream({
      async pull(output) {
        try {
          const next = await reader.read();
          if (next.done) {
            close();
            output.close();
          } else output.enqueue(next.value);
        } catch (error) {
          close();
          output.error(error);
        }
      },
      async cancel() {
        close();
        controller.abort();
        await reader.cancel();
      },
    }),
    { headers: response.headers, status: response.status },
  );
};
let browser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
try {
  browser = await openTestBrowser();
  const pages: { targetId: string; page: Awaited<ReturnType<typeof browser.attach>> }[] = [];
  for (let i = 0; i < 8; i++) {
    const { targetId } = await browser.send("Target.createTarget", {
      url: "about:blank",
      newWindow: true,
    });
    const page = await browser.attach(targetId);
    await page.command("Page.navigate", { url: `${origin}/?tab=${i}` });
    await eventually(() => page.evaluate("!!window.fixture"), "event fixture");
    pages.push({ targetId, page });
  }
  assert.deepEqual(
    await Promise.all(pages.map(({ page }) => page.evaluate("document.visibilityState"))),
    Array(8).fill("visible"),
    "all eight windows compete for leadership",
  );
  await Promise.all(pages.map(({ page }) => page.evaluate("fixture.start()")));
  await eventually(async () => active === 1, "one shared stream");
  await Bun.sleep(200);
  assert.equal(maximum, 1);
  console.log("Eight tabs share one stream");
  const notify = async () => {
    const response = await fetch(`${origin}/api/artifacts/${artifact.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-r3-token": "fixture" },
      body: JSON.stringify({ actor, title: `Updated ${Date.now()}` }),
    });
    assert.equal(response.status, 200);
  };
  await notify();
  for (const { page } of pages)
    await eventually(
      () =>
        page.evaluate(
          `fixture.events.some(e=>e.type==='artifact-updated'&&e.artifactId===${JSON.stringify(artifact.id)})`,
        ),
      "cross-tab invalidation",
    );
  for (const { page } of pages) {
    const status = await page.evaluate(`(async()=>{
      const r=await fetch(${JSON.stringify(`${preview.resourceRoot}image.svg`)},{signal:AbortSignal.timeout(2000)});
      await r.arrayBuffer();return r.status;
    })()`);
    assert.equal(status, 200);
  }
  const publication = await fetch(`${origin}/api/artifacts/${artifact.id}/versions`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-r3-token": "fixture" },
    body: JSON.stringify({
      actor,
      expectedSeq: 1,
      publicationKey: "second",
      content: {
        kind: "html",
        files: [{ path: "index.html", mediaType: "text/html", base64: btoa("<h1>Second</h1>") }],
      },
    }),
  });
  assert.equal(publication.status, 201);
  for (const { page } of pages) {
    await eventually(
      () => page.evaluate("fixture.events.some(e=>e.type==='version-published')"),
      "publication invalidation",
    );
    assert.equal(
      await page.evaluate(
        "fixture.events.filter(e=>e.artifactId).every(e=>Object.keys(e).sort().join(',')==='artifactId,type')",
      ),
      true,
      "only invalidations are relayed",
    );
  }
  const hiddenLeader = Number([...clients.keys()][0]);
  const beforeHide = total;
  await browser.send("Target.activateTarget", { targetId: pages[hiddenLeader]!.targetId });
  const { windowId } = await browser.send("Browser.getWindowForTarget", {
    targetId: pages[hiddenLeader]!.targetId,
  });
  await browser.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
  await eventually(
    () => pages[hiddenLeader]!.page.evaluate("document.hidden"),
    "leader becomes hidden",
  );
  await eventually(
    async () => active === 1 && total > beforeHide,
    "hidden leader releases connection",
  );
  await browser.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
  await eventually(() => pages[hiddenLeader]!.page.evaluate("!document.hidden"), "tab resumes");
  const leader = Number([...clients.keys()][0]);
  const beforeClose = total;
  await browser.send("Target.closeTarget", { targetId: pages[leader]!.targetId });
  const remaining = pages.filter((_, i) => i !== leader);
  await eventually(async () => active === 1 && total > beforeClose, "leader takeover");
  for (const { page } of remaining) await page.evaluate("fixture.events.length=0");
  await notify();
  for (const { page } of remaining)
    await eventually(
      () => page.evaluate("fixture.events.some(e=>e.type==='artifact-updated')"),
      "updates after takeover",
    );
  const beforeReconnect = total;
  clients.values().next().value!.abort();
  await eventually(async () => active === 1 && total > beforeReconnect, "server reconnect");
  await remaining[0]!.page.evaluate("fixture.logout()");
  await eventually(async () => active === 0, "logout closes every subscription");
  await Bun.sleep(600);
  assert.equal(active, 0);
  for (const { targetId } of remaining) await browser.send("Target.closeTarget", { targetId });
  // Clear the test origin's suspended authentication state for the fallback case.
  const { targetId } = await browser.send("Target.createTarget", {
    url: "about:blank",
    newWindow: true,
  });
  const fallback = await browser.attach(targetId);
  await fallback.command("Page.addScriptToEvaluateOnNewDocument", {
    source: "Object.defineProperty(navigator,'locks',{value:undefined});localStorage.clear();",
  });
  await fallback.command("Page.navigate", { url: origin });
  await eventually(() => fallback.evaluate("!!window.fixture"), "fallback fixture");
  const beforeFallback = total;
  await fallback.evaluate("fixture.start()");
  await eventually(
    () => fallback.evaluate("fixture.events.some(e=>e.type==='ready')"),
    "initial fallback refresh",
  );
  await fallback.evaluate("fixture.events.length=0");
  await Bun.sleep(15_100);
  assert.ok(await fallback.evaluate("fixture.events.some(e=>e.type==='ready')"));
  assert.equal(total, beforeFallback);
  console.log("Invalidations, image headers, takeover, reconnect, logout, and polling passed");
} finally {
  await browser?.close();
  await runtime.stop();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
