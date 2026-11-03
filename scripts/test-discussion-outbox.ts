import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactApi } from "../server/artifact-api.ts";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import { eventually, openTestBrowser } from "./browser.ts";
import { browserLoweredCssPlugin } from "./spa-css.ts";

const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "preview-workspace-fixture.tsx")],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [await browserLoweredCssPlugin()],
});
if (!build.success) throw new Error("Thread acceptance workspace failed to build");
const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
const js = build.outputs
  .find((output) => output.path.endsWith(".js"))!
  .path.split("/")
  .at(-1)!;
const css = build.outputs
  .find((output) => output.path.endsWith(".css"))
  ?.path.split("/")
  .at(-1);
const root = await mkdtemp(join(tmpdir(), "r3-threads-acceptance-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human" as const, sessionId: null };
const artifact = storage.artifacts.create({
  kind: "files",
  actor,
  title: "Discussion interactions",
});
await storage.artifacts.publish(artifact.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "threads-interactions",
  content: {
    kind: "files",
    files: [
      {
        path: "index.md",
        mediaType: "text/markdown",
        base64: Buffer.from("# Review this document").toString("base64"),
      },
    ],
  },
});
const notes = await Promise.all(
  ["First decision", "Second decision"].map((body) =>
    storage.conversations.add(artifact.id, { actor, body, target: { kind: "artifact" } }),
  ),
);
const api = createArtifactApi(storage, {
  token: randomBytes(32).toString("base64url"),
  requireLogin: false,
  version: "acceptance",
  allowedHost: (host) => host === "localhost",
});
const pending: {
  request: Request;
  respond: (response: Response) => void;
}[] = [];
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 60,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (request.method === "POST" && (path.endsWith("/comments") || path.endsWith("/threads")))
      return new Promise<Response>((respond) => pending.push({ request, respond }));
    if (path.startsWith("/api/")) {
      const response = await api.app.fetch(request);
      return response;
    }
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
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 1400,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await page.command("Page.navigate", { url: `http://localhost:${app.port}/?version=1` });
  const card = (id: string) =>
    `document.querySelector('[data-artifact-thread="${id}"]:not([inert]):not([inert] *)')`;
  await eventually(() => page.evaluate(`!!${card(notes[0].id)}`), "threads cards");
  const reply = async (body: string, image = false) => {
    await page.evaluate(
      `${card(notes[0].id)}.querySelector('[data-thread-action="comment"]').click()`,
    );
    await eventually(
      () =>
        page.evaluate(`!!document.querySelector('[data-comment-to="${notes[0].id}"] textarea')`),
      "reply composer",
    );
    await page.evaluate(`(() => {
      const input = document.querySelector('[data-comment-to="${notes[0].id}"] textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, ${JSON.stringify(body)});
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    if (image) {
      await page.evaluate(`(async () => {
        const canvas = document.createElement('canvas'); canvas.width = 16; canvas.height = 16;
        canvas.getContext('2d').fillRect(0, 0, 16, 16);
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const data = new DataTransfer(); data.items.add(new File([blob], 'queued.png', { type: 'image/png' }));
        document.querySelector('[data-comment-to="${notes[0].id}"] textarea').dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }));
      })()`);
      await eventually(
        () =>
          page.evaluate(
            `!!document.querySelector('[data-comment-to="${notes[0].id}"] img') && !document.querySelector('[data-comment-to="${notes[0].id}"] button[type=submit]').disabled`,
          ),
        "image durably prepared",
      );
    }
    await page.evaluate(
      `document.querySelector('[data-comment-to="${notes[0].id}"]').requestSubmit()`,
    );
  };
  const queued = () => page.evaluate("document.querySelectorAll('[data-outgoing-message]').length");
  await page.command("Network.enable");
  await page.command("Network.emulateNetworkConditions", {
    offline: true,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await reply("Reply during disconnection");
  await eventually(async () => (await queued()) === 1, "offline reply appears immediately");
  assert.equal(pending.length, 0, "offline does not send");
  if (process.env.R3_TEST_SCREENSHOTS) {
    const shot = await page.command("Page.captureScreenshot", { format: "png" });
    await Bun.write(
      join(process.env.R3_TEST_SCREENSHOTS, "discussion-outbox.png"),
      Buffer.from(shot.data, "base64"),
    );
  }
  assert.equal(
    await page.evaluate(`!!document.querySelector('[data-comment-to="${notes[0].id}"]')`),
    false,
    "composer closes before network recovery",
  );
  await page.command("Network.emulateNetworkConditions", {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  });
  await eventually(async () => pending.length === 1, "automatic send after network recovery");
  const lost = pending.shift()!;
  const originalBody = await lost.request.clone().json();
  const committed = await api.app.fetch(lost.request);
  assert.equal(committed.status, 201);
  lost.respond(
    new Response(JSON.stringify({ error: "Lost response after commit" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }),
  );
  await eventually(async () => pending.length === 1, "automatic retry after lost response");
  const retry = pending.shift()!;
  assert.deepEqual(
    await retry.request.clone().json(),
    originalBody,
    "retry preserves exact payload and operation key",
  );
  retry.respond(await api.app.fetch(retry.request));
  await eventually(async () => (await queued()) === 0, "acknowledged reply leaves outbox");
  assert.equal(
    storage.conversations
      .list(artifact.id)[0]
      .comments.filter((comment) => comment.body === "Reply during disconnection").length,
    1,
    "ambiguous response cannot duplicate a reply",
  );

  await reply("Survives a reload", true);
  await eventually(async () => pending.length === 1, "second reply held");
  const imageAttempt = pending.shift()!;
  const imageBody = await imageAttempt.request.clone().json();
  assert.equal(imageBody.attachments.length, 1);
  imageAttempt.respond(new Response(null, { status: 503 }));
  await page.command("Page.reload");
  await eventually(async () => (await queued()) === 1, "pending reply survives reload");
  await eventually(async () => pending.length === 1, "reload resumes sending");
  const reloaded = pending.shift()!;
  assert.deepEqual(
    await reloaded.request.clone().json(),
    imageBody,
    "reload preserves exact image bytes and operation identity",
  );
  reloaded.respond(
    new Response(JSON.stringify({ error: "Artifact is archived" }), {
      status: 409,
      headers: { "content-type": "application/json" },
    }),
  );
  await eventually(
    () =>
      page.evaluate(
        "document.querySelector('[data-outgoing-message]')?.textContent.includes('Artifact is archived')",
      ),
    "permanent rejection retained visibly",
  );
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(pending.length, 0, "permanent rejection does not spin retries");
  await page.evaluate(
    "[...document.querySelectorAll('[data-outgoing-message] button')].find(button => button.textContent === 'Move to draft').click()",
  );
  await eventually(async () => (await queued()) === 0, "failed reply restored to draft");
  assert.ok(
    await page.evaluate(
      "Object.keys(localStorage).some(key => key.startsWith('r3-artifact-draft-slot-') && localStorage.getItem(key).includes('Survives a reload'))",
    ),
    "restored draft is durable",
  );

  await reply("Cancelled by logout");
  await eventually(async () => pending.length === 1, "third reply held");
  const late = pending.shift()!;
  await page.evaluate("window.dispatchEvent(new CustomEvent('r3-images-cleared'))");
  await eventually(async () => (await queued()) === 0, "logout clears queued messages");
  late.respond(new Response(null, { status: 503 }));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(pending.length, 0, "late failure cannot resurrect a cleared operation");
  console.log(
    "Discussion outbox: immediate offline reply, automatic recovery, exact retry after lost acknowledgment, reload persistence, permanent failure recovery, logout revocation passed.",
  );
} finally {
  for (const request of pending) request.respond(new Response(null, { status: 503 }));
  await browser?.close();
  app.stop(true);
  api.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
