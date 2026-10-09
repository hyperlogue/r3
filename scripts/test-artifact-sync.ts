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
if (!build.success) throw new Error("Discussion acceptance workspace failed to build");
const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
const js = build.outputs
  .find((output) => output.path.endsWith(".js"))!
  .path.split("/")
  .at(-1)!;
const css = build.outputs
  .find((output) => output.path.endsWith(".css"))
  ?.path.split("/")
  .at(-1);
const root = await mkdtemp(join(tmpdir(), "r3-discussions-acceptance-"));
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
  publicationKey: "discussions-interactions",
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
let fullReads = 0;
let incrementalReads = 0;
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
    if (request.method === "PATCH" && /^\/api\/discussions\/[^/]+$/.test(path))
      return new Promise<Response>((respond) => pending.push({ request, respond }));
    if (path.startsWith("/api/")) {
      const response = await api.app.fetch(request);
      if (path === `/api/artifacts/${artifact.id}` && request.method === "GET" && response.ok) {
        const bytes = new Uint8Array(await response.clone().arrayBuffer());
        const payload = JSON.parse(
          new TextDecoder().decode(
            response.headers.get("content-encoding") === "gzip" ? Bun.gunzipSync(bytes) : bytes,
          ),
        );
        if (payload.delta === true) incrementalReads++;
        else fullReads++;
      }
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
    `document.querySelector('[data-artifact-discussions="${id}"]:not([inert]):not([inert] *)')`;
  await eventually(() => page.evaluate(`!!${card(notes[0].id)}`), "discussions cards");
  // Keep the HTTP mutation pending. The user should see resolution immediately,
  // rather than paying for the mutation plus a subsequent artifact refetch.
  await page.evaluate(
    `${card(notes[0].id)}.querySelector('[data-discussions-action="resolve"]').click()`,
  );
  await eventually(async () => pending.length === 1, "held status mutation");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(
    await page.evaluate("document.querySelector('[data-discussions-tab=active]').textContent"),
    "Active 1",
    "Resolve must update the queue before its HTTP response",
  );
  await storage.conversations.addComment(notes[1].id, {
    actor,
    body: "A comment arrived while saving",
    context: { versionSeq: 1, representation: "source" },
  });
  api.collaboration.broadcast({
    type: "discussions-updated",
    artifactId: artifact.id,
    discussionId: notes[1].id,
  });
  await eventually(
    () => page.evaluate("document.body.textContent.includes('A comment arrived while saving')"),
    "concurrent comment is refetched",
  );
  assert.equal(
    await page.evaluate("document.querySelector('[data-discussions-tab=active]').textContent"),
    "Active 1",
    "Refetching a comment must preserve the pending resolution",
  );
  await page.evaluate(
    `${card(notes[1].id)}.querySelector('[data-discussions-action="resolve"]').click()`,
  );
  await eventually(async () => pending.length === 2, "two independent status mutations");
  await eventually(
    () =>
      page.evaluate(
        "document.querySelector('[data-discussions-tab=active]').textContent === 'Active 0'",
      ),
    "both decisions are optimistic",
  );
  const first = pending.shift()!;
  first.respond(
    new Response(JSON.stringify({ error: "Simulated save failure" }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }),
  );
  await eventually(
    () =>
      page.evaluate(
        "document.querySelector('[data-discussions-tab=active]').textContent === 'Active 1'",
      ),
    "failed resolution restores the thread",
  );
  assert.equal(storage.conversations.list(artifact.id)[0].status, "open");
  await eventually(
    () => page.evaluate(`${card(notes[0].id)}?.textContent.includes('Simulated save failure')`),
    "failed save is explained on the restored card",
  );
  const second = pending.shift()!;
  second.respond(await api.app.fetch(second.request));
  await eventually(
    async () => storage.conversations.list(artifact.id)[1].status === "resolved",
    "other resolution persists independently",
  );
  assert.ok(incrementalReads > 0, "Conversation changes must use incremental reads");
  const fullBefore = fullReads;
  storage.artifacts.edit(artifact.id, { title: "Renamed during review" });
  api.collaboration.broadcast({ type: "artifact-updated", artifactId: artifact.id });
  await eventually(
    () => page.evaluate("document.body.textContent.includes('Renamed during review')"),
    "metadata fallback updates the workspace",
  );
  assert.ok(fullReads > fullBefore, "Metadata changes recover through full detail");
  storage.conversations.delete(notes[0].id, actor);
  api.collaboration.broadcast({
    type: "discussions-updated",
    artifactId: artifact.id,
    discussionId: notes[0].id,
  });
  await eventually(
    () => page.evaluate(`!${card(notes[0].id)}`),
    "deleted discussion leaves the cache",
  );
  console.log(
    "Incremental discussion reads preserve pending decisions, show concurrent comments, remove deleted discussions, and recover metadata with a full snapshot.",
  );
} finally {
  for (const request of pending) request.respond(new Response(null, { status: 503 }));
  await browser?.close();
  app.stop(true);
  api.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
}
