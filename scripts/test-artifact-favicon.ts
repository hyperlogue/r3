import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactApi } from "../server/artifact-api.ts";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import { eventually, openTestBrowser } from "./browser.ts";
import { browserLoweredCssPlugin } from "./spa-css.ts";

// Exercise the real app, event invalidation, and rendered favicon in an isolated profile.
const build = await Bun.build({
  entrypoints: [join(import.meta.dir, "../web/src/main.tsx")],
  target: "browser",
  minify: true,
  define: { "process.env.NODE_ENV": '"production"' },
  plugins: [await browserLoweredCssPlugin()],
});
if (!build.success) throw new Error("Favicon acceptance app failed to build");
const assets = new Map(build.outputs.map((output) => [output.path.split("/").at(-1)!, output]));
const script = build.outputs
  .find((output) => output.path.endsWith(".js"))!
  .path.split("/")
  .at(-1)!;
const css = build.outputs
  .find((output) => output.path.endsWith(".css"))!
  .path.split("/")
  .at(-1)!;
const favicon = await Bun.file(join(import.meta.dir, "../web/favicon.svg")).text();
const root = await mkdtemp(join(tmpdir(), "r3-favicon-"));
const storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
const actor = { role: "human" as const, sessionId: null };
const artifact = storage.artifacts.create({ kind: "files", actor, title: "Tab notifications" });
await storage.artifacts.publish(artifact.id, {
  actor,
  expectedSeq: 0,
  publicationKey: "favicon",
  content: {
    kind: "files",
    files: [{ path: "note.txt", mediaType: "text/plain", base64: btoa("Review this note.") }],
  },
});
storage.artifacts.registerSession({ id: "favicon-agent", harness: "acceptance" });
const note = await storage.conversations.add(artifact.id, {
  actor,
  body: "Please check this note.",
  target: { kind: "artifact" },
});
const api = createArtifactApi(storage, {
  token: randomBytes(32).toString("base64url"),
  requireLogin: false,
  version: "acceptance",
  allowedHost: (host) => host === "localhost",
});
const app = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 60,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) return api.app.fetch(request);
    if (path === "/favicon.svg")
      return new Response(favicon, { headers: { "content-type": "image/svg+xml" } });
    const asset = assets.get(path.slice(1));
    if (asset) return new Response(asset);
    return new Response(
      `<!doctype html><html><head><link rel="icon" type="image/svg+xml" href="/favicon.svg"><link rel="stylesheet" href="/${css}"></head><body><div id="root"></div><script type="module" src="/${script}"></script></body></html>`,
      { headers: { "content-type": "text/html" } },
    );
  },
});
let browser: Awaited<ReturnType<typeof openTestBrowser>> | undefined;
try {
  browser = await openTestBrowser();
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const page = await browser.attach(targetId);
  await page.command("Page.navigate", { url: `http://localhost:${app.port}/${artifact.id}` });
  await eventually(
    () => page.evaluate("!!document.querySelector('[data-feedback-mode]')"),
    "artifact workspace",
  );
  const icon = "document.querySelector('link[rel=icon]').href";
  const original = await page.evaluate<string>(icon);
  const changed = async () => (await page.evaluate(icon)) !== original;
  const notify = () =>
    api.collaboration.broadcast({
      type: "feedback-updated",
      artifactId: artifact.id,
      feedbackId: note.id,
    });
  await storage.conversations.addReply(note.id, {
    actor: { role: "agent", sessionId: "favicon-agent" },
    body: "Ready for your review.",
    context: { versionSeq: 1, representation: "source" },
  });
  notify();
  await eventually(
    () => page.evaluate("!!document.querySelector('[data-feedback-attention]')"),
    "agent reply reaches the panel attention indicator",
  );
  await eventually(changed, "unhandled agent feedback adds the favicon notification dot");
  const pixel = await page.evaluate<number[]>(`new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 100;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, 100, 100);
      resolve([...context.getImageData(82, 82, 1, 1).data]);
    };
    image.onerror = () => reject(new Error('Notification favicon cannot be rendered'));
    image.src = ${icon};
  })`);
  assert(pixel[2] > pixel[0] && pixel[2] > pixel[1], "the favicon dot renders blue");
  await storage.conversations.addReply(note.id, {
    actor,
    body: "Thanks, reviewed.",
    context: { versionSeq: 1, representation: "source" },
  });
  notify();
  await eventually(async () => !(await changed()), "a human reply clears the favicon dot");
  await storage.conversations.addReply(note.id, {
    actor: { role: "agent", sessionId: "favicon-agent" },
    body: "One more item for your review.",
    context: { versionSeq: 1, representation: "source" },
  });
  notify();
  await eventually(changed, "another agent reply restores the dot");
  await page.evaluate("document.querySelector('a[title=\"All artifacts\"]').click()");
  await eventually(async () => !(await changed()), "leaving the artifact restores the normal icon");
  await eventually(
    () => page.evaluate(`!!document.querySelector('a[href="/${artifact.id}"]')`),
    "artifact list",
  );
  await page.evaluate(`document.querySelector('a[href="/${artifact.id}"]').click()`);
  await eventually(changed, "reopening an artifact retains its unhandled attention");
  await page.evaluate("document.querySelector('[data-feedback-action=resolve]').click()");
  await eventually(async () => !(await changed()), "resolving feedback clears the favicon dot");
  console.log(
    "Favicon acceptance passed: blue agent-attention dot, human replies, resolution, and navigation cleanup.",
  );
} finally {
  await browser?.close();
  app.stop(true);
  api.close();
  await storage.close();
  await rm(root, { recursive: true, force: true });
}
