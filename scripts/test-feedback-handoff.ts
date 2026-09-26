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
if (!build.success) throw new Error("Feedback acceptance workspace failed to build");
const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
const js = build.outputs
  .find((output) => output.path.endsWith(".js"))!
  .path.split("/")
  .at(-1)!;
const css = build.outputs
  .find((output) => output.path.endsWith(".css"))
  ?.path.split("/")
  .at(-1);
const root = await mkdtemp(join(tmpdir(), "r3-feedback-acceptance-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human" as const, sessionId: null };
const artifact = storage.artifacts.create({ kind: "files", actor, title: "Feedback interactions" });
await storage.artifacts.publish(artifact.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "feedback-interactions",
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
  ["Review this feedback"].map((body) =>
    storage.conversations.add(artifact.id, { actor, body, target: { kind: "artifact" } }),
  ),
);
const deliveries: {
  accept: (state?: "sent" | "queued") => void;
  reject: (error: Error) => void;
}[] = [];
const api = createArtifactApi(
  storage,
  {
    token: randomBytes(32).toString("base64url"),
    requireLogin: false,
    version: "acceptance",
    allowedHost: (host) => host === "localhost",
  },
  {
    deliver: () =>
      new Promise<"sent" | "queued">((resolve, reject) =>
        deliveries.push({ accept: (state = "sent") => resolve(state), reject }),
      ),
  },
);
const listener = { role: "agent" as const, sessionId: "handoff-agent" };
storage.artifacts.registerSession({ id: listener.sessionId, label: "Review assistant" });
storage.listeners.setTarget(listener.sessionId, { harness: "codex", threadId: "handoff-thread" });
storage.listeners.register(artifact.id, listener, "fallback");
let completed = 0;
let feedbackReadRequests = 0;
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 60,
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) {
      if (/\/feedback\/(pending|history|acknowledge)$/.test(path)) feedbackReadRequests++;
      const response = await api.app.fetch(request);
      if (path.endsWith("/submit")) completed++;
      return response;
    }
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
  const button = "document.querySelector('[data-feedback-header] [data-artifact-handoff]')";
  const navButton = "document.querySelector('[data-app-header] [data-artifact-handoff]')";
  await eventually(
    () =>
      page.evaluate(
        `!!${button} && (${button}).textContent.startsWith("Send to agent") && !(${button}).disabled`,
      ),
    "ready handoff button",
  );
  const otherTarget = await browser.send("Target.createTarget", {
    url: `http://localhost:${app.port}/?version=1`,
  });
  const other = await browser.attach(otherTarget.targetId);
  await eventually(
    () =>
      other.evaluate(
        `!!${button} && (${button}).textContent.startsWith('Send to agent') && !(${button}).disabled`,
      ),
    "second tab ready",
  );
  await page.command("Page.bringToFront");
  assert.equal(await page.evaluate("!!document.querySelector('[data-feedback-attention]')"), false);
  await page.evaluate("document.querySelector('[aria-label=\"Hide feedback\"]').click()");
  await page.evaluate(`(${navButton}).click()`);
  await eventually(async () => deliveries.length === 1, "pending notification delivery");
  assert.equal(await page.evaluate(`(${button}).textContent`), "Sending…");
  assert.equal(await page.evaluate(`(${button}).disabled`), true);
  assert.equal(await page.evaluate(`(${navButton}).disabled`), true);
  await page.evaluate(`(${button}).click()`);
  assert.equal(deliveries.length, 1, "navbar and panel share the in-flight handoff guard");
  deliveries.shift()!.accept("queued");
  await eventually(async () => completed === 1, "successful local harness delivery");
  await page.evaluate(
    "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
  );
  assert.equal(
    await page.evaluate(`(${navButton}).textContent`),
    "Queued",
    "Codex queue acceptance should show Queued without claiming a live consumer",
  );
  assert.equal(await page.evaluate(`(${button}).disabled`), true);
  assert.equal(
    storage.conversations.unsent(artifact.id)[0]?.id,
    notes[0].id,
    "A ping does not acknowledge the feedback snapshot",
  );
  await eventually(
    () => other.evaluate(`(${button}).disabled && (${button}).title.startsWith('Already sent')`),
    "successful ping disables the unchanged snapshot in another tab",
  );
  await Bun.sleep(3200);
  assert.equal(await page.evaluate(`!!(${navButton})`), false, "sent batches leave the navbar");
  assert.equal(await page.evaluate(`(${button}).textContent`), "Send to agent · 1");
  assert.equal(
    await page.evaluate(`(${button}).disabled`),
    true,
    "Sent expires without enabling a duplicate ping",
  );
  await page.command("Page.reload");
  await eventually(
    () => page.evaluate(`!!${button} && (${button}).title.startsWith('Already sent')`),
    "receipt survives reload before the agent reads feedback",
  );
  assert.equal(await page.evaluate(`!!(${navButton})`), false);
  await page.evaluate("document.querySelector('[aria-label=\"Show feedback\"]').click()");
  storage.conversations.claim([notes[0].id], listener.sessionId);
  await storage.conversations.addReply(notes[0].id, {
    actor: listener,
    body: "Agent is checking this",
    context: { versionSeq: null, representation: null },
  });
  api.collaboration.broadcast({
    type: "feedback-updated",
    artifactId: artifact.id,
    feedbackId: notes[0].id,
  });
  await eventually(
    () => page.evaluate("document.body.textContent.includes('Agent is checking this')"),
    "agent activity reaches the browser",
  );
  await eventually(
    () => page.evaluate("document.body.textContent.includes('Agent · Review assistant')"),
    "agent replies display the readable session name",
  );
  assert.equal(await page.evaluate("!!document.querySelector('[data-feedback-attention]')"), true);
  assert.equal(
    await page.evaluate(`(${button}).disabled`),
    true,
    "Agent replies and claims do not enable another ping",
  );
  storage.conversations.edit(notes[0].id, { actor, body: "Updated human feedback" });
  api.collaboration.broadcast({
    type: "feedback-updated",
    artifactId: artifact.id,
    feedbackId: notes[0].id,
  });
  await eventually(() => page.evaluate(`!(${button}).disabled`), "human edit enables Send");
  await page.evaluate(`(${button}).click()`);
  await eventually(async () => deliveries.length === 1, "second ping pending");
  const reply = await storage.conversations.addReply(notes[0].id, {
    actor,
    body: "More input during delivery",
    context: { versionSeq: null, representation: null },
  });
  api.collaboration.broadcast({
    type: "feedback-updated",
    artifactId: artifact.id,
    feedbackId: notes[0].id,
  });
  await eventually(
    () => page.evaluate("document.body.textContent.includes('More input during delivery')"),
    "concurrent human reply",
  );
  assert.equal(await page.evaluate("!!document.querySelector('[data-feedback-attention]')"), false);
  deliveries.shift()!.accept();
  await eventually(
    () => page.evaluate(`!(${button}).disabled`),
    "successful older ping does not suppress newer input",
  );
  await page.evaluate(`(${button}).click()`);
  await eventually(async () => deliveries.length === 1, "failed ping pending");
  deliveries.shift()!.reject(new Error("Simulated delivery failure"));
  await eventually(
    () =>
      page.evaluate(
        "[...document.querySelectorAll('[role=alert]')].some(alert=>alert.textContent.includes('Simulated delivery failure'))",
      ),
    "delivery failure is visible",
  );
  assert.equal(
    api.collaboration.watchers(artifact.id)[0]?.mode,
    "fallback",
    "A failed fallback remains registered for retry",
  );
  api.collaboration.listen(artifact.id, listener);
  await eventually(
    () =>
      page.evaluate(`(${button}).textContent.startsWith('Send to agent') && !(${button}).disabled`),
    "failed delivery can be retried after listener reconnects",
  );
  await page.evaluate(`(${button}).click()`);
  await eventually(async () => deliveries.length === 1, "retry delivery");
  deliveries.shift()!.accept();
  await eventually(
    () => page.evaluate(`(${button}).textContent === 'Sent' && (${button}).disabled`),
    "successful retry",
  );
  storage.conversations.editReply(reply.id, { actor, body: "Edited human reply" });
  api.collaboration.broadcast({
    type: "feedback-updated",
    artifactId: artifact.id,
    feedbackId: notes[0].id,
  });
  await eventually(
    () => page.evaluate(`!(${button}).disabled`),
    "human reply edit enables Send during Sent flash",
  );
  await page.evaluate(`(${button}).click()`);
  await eventually(async () => deliveries.length === 1, "older tab submission");
  const extra = await storage.conversations.add(artifact.id, {
    actor,
    body: "New feedback while another tab sends",
    target: { kind: "artifact" },
  });
  api.collaboration.broadcast({
    type: "feedback-updated",
    artifactId: artifact.id,
    feedbackId: extra.id,
  });
  await eventually(
    () =>
      other.evaluate(
        `!(${button}).disabled && document.body.textContent.includes('New feedback while another tab sends')`,
      ),
    "new input in the other tab",
  );
  await other.evaluate(`(${button}).click()`);
  await eventually(async () => deliveries.length === 2, "newer tab submission");
  deliveries.pop()!.accept();
  await eventually(
    () => other.evaluate(`(${button}).textContent === 'Sent'`),
    "newer submission completes first",
  );
  deliveries.shift()!.accept();
  await eventually(
    () => page.evaluate(`(${button}).disabled && (${button}).textContent !== 'Sending…'`),
    "older completion preserves the newer receipt",
  );
  assert.equal(await other.evaluate(`(${button}).disabled`), true);

  api.collaboration.unregister(artifact.id, api.collaboration.watchers(artifact.id)[0].id);
  storage.conversations.acknowledge(
    artifact.id,
    storage.conversations.snapshot(artifact.id).acknowledgment,
  );
  const waiting = api.collaboration.watch(artifact.id, listener);
  const generic = await storage.conversations.add(artifact.id, {
    actor,
    body: "Feedback for a generic agent",
    target: { kind: "artifact" },
  });
  api.collaboration.broadcast({
    type: "feedback-updated",
    artifactId: artifact.id,
    feedbackId: generic.id,
  });
  await eventually(
    () =>
      page.evaluate(`(${button}).textContent.startsWith('Send to agent') && !(${button}).disabled`),
    "generic watcher receives human input",
  );
  await page.evaluate(`(${button}).click()`);
  assert.deepEqual(await waiting, { result: "feedback" });
  await eventually(
    () => page.evaluate(`(${button}).textContent === 'Sent' && (${button}).disabled`),
    "generic watch handoff confirms Sent",
  );
  assert.equal(storage.conversations.unsent(artifact.id).length, 1);

  api.collaboration.listen(artifact.id, listener);
  const agentNote = await storage.conversations.add(artifact.id, {
    actor: listener,
    body: "Agent-authored note",
    target: { kind: "artifact" },
  });
  storage.conversations.edit(agentNote.id, { actor, status: "resolved" });
  api.collaboration.broadcast({
    type: "feedback-updated",
    artifactId: artifact.id,
    feedbackId: agentNote.id,
  });
  await eventually(
    () =>
      page.evaluate(`(${button}).textContent.startsWith('Send to agent') && !(${button}).disabled`),
    "human status decision can be sent",
  );
  await page.evaluate(`(${button}).click()`);
  await eventually(async () => deliveries.length === 1, "human status ping");
  deliveries.shift()!.accept();
  await eventually(
    () => page.evaluate(`(${button}).textContent === 'Sent'`),
    "status ping succeeds",
  );
  storage.conversations.edit(agentNote.id, { actor: listener, body: "Agent edits its own note" });
  api.collaboration.broadcast({
    type: "feedback-updated",
    artifactId: artifact.id,
    feedbackId: agentNote.id,
  });
  await page.evaluate("document.querySelector('[data-feedback-tab=resolved]').click()");
  await eventually(
    () => page.evaluate("document.body.textContent.includes('Agent edits its own note')"),
    "agent body edit reaches the browser",
  );
  assert.equal(
    await page.evaluate(`(${button}).disabled`),
    true,
    "An agent body edit does not invalidate a human status receipt",
  );

  for (const status of ["open", "resolved"] as const) {
    storage.conversations.edit(agentNote.id, { actor, status });
    api.collaboration.broadcast({
      type: "feedback-updated",
      artifactId: artifact.id,
      feedbackId: agentNote.id,
    });
    await eventually(
      () => page.evaluate(`!(${button}).disabled`),
      "a repeated human status remains a new decision",
    );
    await page.evaluate(`(${button}).click()`);
    await eventually(async () => deliveries.length === 1, "repeated status ping");
    deliveries.shift()!.accept();
    await eventually(
      () => page.evaluate(`(${button}).textContent === 'Sent'`),
      "repeated status sent",
    );
  }
  for (const body of ["A changed reply", "Edited human reply"]) {
    storage.conversations.editReply(reply.id, { actor, body });
    api.collaboration.broadcast({
      type: "feedback-updated",
      artifactId: artifact.id,
      feedbackId: notes[0].id,
    });
    await eventually(
      () => page.evaluate(`!(${button}).disabled`),
      "reverting to previously sent reply text remains new input",
    );
    await page.evaluate(`(${button}).click()`);
    await eventually(async () => deliveries.length === 1, "repeated reply text ping");
    deliveries.shift()!.accept();
    await eventually(
      () => page.evaluate(`(${button}).textContent === 'Sent'`),
      "repeated reply text sent",
    );
  }
  for (const unavailable of [true, false]) {
    const injected = await page.command("Page.addScriptToEvaluateOnNewDocument", {
      source: `Object.defineProperty(crypto,'subtle',{value:${unavailable ? "undefined" : '{digest:async()=>{throw new Error("Unavailable digest")}}'},configurable:true})`,
    });
    await page.command("Page.reload");
    await eventually(
      () =>
        page.evaluate(
          `!!${button} && (${button}).textContent.startsWith('Send to agent') && !(${button}).disabled`,
        ),
      "handoff remains available without working Web Crypto",
    );
    await page.evaluate(`(${button}).click()`);
    await eventually(async () => deliveries.length === 1, "compatibility ping");
    deliveries.shift()!.accept();
    await eventually(
      () => page.evaluate(`(${button}).textContent === 'Sent' && (${button}).disabled`),
      "in-memory compatibility receipt",
    );
    assert.equal(
      await page.evaluate(
        "Object.values(JSON.parse(localStorage.getItem('r3-feedback-notifications') ?? '{}')).flatMap(entry=>entry.delivered?.hashes ?? []).every(hash=>/^[a-f0-9]{64}$/.test(hash))",
      ),
      true,
      "Fallback inputs never enter persistent storage",
    );
    await page.command("Page.removeScriptToEvaluateOnNewDocument", {
      identifier: injected.identifier,
    });
  }
  api.collaboration.unlisten(artifact.id, listener);
  await eventually(
    () => page.evaluate(`(${navButton})?.textContent === 'Use in agent'`),
    "unwatched artifacts offer the fetch command despite prior notification receipts",
  );
  const pendingBeforeCopy = storage.conversations.unsent(artifact.id);
  const feedbackReadRequestsBeforeCopy = feedbackReadRequests;
  await page.evaluate(`(${navButton}).click()`);
  const popup =
    "document.querySelector('[role=dialog][aria-label=\"Read feedback in your agent\"]')";
  await eventually(() => page.evaluate(`!!${popup}`), "command popover");
  assert.equal(
    await page.evaluate(`(${popup}).querySelector('div > code').textContent`),
    `r3 feedback fetch ${artifact.id}`,
  );
  assert.equal(
    await page.evaluate("document.activeElement.getAttribute('aria-label')"),
    "Copy command",
  );
  await page.evaluate(
    "window.copiedCommand = null; Object.defineProperty(navigator, 'clipboard', {configurable:true,value:{writeText:async text=>{window.copiedCommand=text}}})",
  );
  await page.evaluate(`(${popup}).querySelector('button').click()`);
  await eventually(
    () =>
      page.evaluate(
        `(${popup}).querySelector('button').getAttribute('aria-label') === 'Command copied'`,
      ),
    "copy confirmation",
  );
  assert.equal(await page.evaluate("window.copiedCommand"), `r3 feedback fetch ${artifact.id}`);
  assert.deepEqual(storage.conversations.unsent(artifact.id), pendingBeforeCopy);
  assert.equal(
    feedbackReadRequests,
    feedbackReadRequestsBeforeCopy,
    "copying makes no feedback read or acknowledgment requests",
  );
  await page.command("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape" });
  await page.command("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape" });
  await eventually(() => page.evaluate(`!${popup}`), "Escape dismisses the command");
  assert.equal(await page.evaluate(`document.activeElement === ${navButton}`), true);

  // Exercise the same panel control at phone width, including the clipped sheet.
  await page.command("Emulation.setDeviceMetricsOverride", {
    width: 390,
    height: 844,
    deviceScaleFactor: 1,
    mobile: true,
  });
  const mobileToggle =
    "[...document.querySelectorAll('button')].find(button=>/^Feedback\\s*·.*open$/.test(button.textContent))";
  await eventually(() => page.evaluate(`!!(${mobileToggle})`), "phone feedback control");
  await page.evaluate(`(${mobileToggle}).click()`);
  await page.evaluate(`(${button}).click()`);
  await eventually(() => page.evaluate(`!!${popup}`), "phone command popover");
  const bounds = await page.evaluate(
    `(()=>{const rect=(${popup}).getBoundingClientRect();return {left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,width:innerWidth,height:innerHeight}})()`,
  );
  assert.ok(bounds.left >= 0 && bounds.right <= bounds.width);
  assert.ok(bounds.top >= 0 && bounds.bottom <= bounds.height);
  await page.evaluate(
    "navigator.clipboard.writeText=async()=>{throw new Error('Denied')};document.execCommand=()=>false",
  );
  await page.evaluate(`(${popup}).querySelector('button').click()`);
  await eventually(
    () => page.evaluate(`(${popup}).textContent.includes('Clipboard access failed')`),
    "copy failure keeps a selectable command",
  );
  assert.deepEqual(storage.conversations.unsent(artifact.id), pendingBeforeCopy);
  assert.equal(feedbackReadRequests, feedbackReadRequestsBeforeCopy);
  console.log(
    "Notification delivery and command copying preserve pending feedback; command popovers work on desktop and mobile.",
  );
} finally {
  for (const delivery of deliveries) delivery.reject(new Error("Test ended"));
  await browser?.close();
  app.stop(true);
  storage.close();
  await rm(root, { recursive: true, force: true });
}
