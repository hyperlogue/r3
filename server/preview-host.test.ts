import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ArtifactPreviewContext } from "../shared/artifacts.ts";
import { type ArtifactStorage, openArtifactStorage } from "./artifact-storage.ts";
import { PreviewHost } from "./preview-host.ts";

let root: string;
let storage: ArtifactStorage;
let host: PreviewHost;
let context: ArtifactPreviewContext;
let id: string;
const html =
  "<!doctype html><html><head><title>Published</title></head><body><h1>Published page</h1></body></html>";
const actor = { role: "human" as const, sessionId: null };
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-preview-host-"));
  storage = await openArtifactStorage({
    databasePath: join(root, "store.sqlite"),
    render: async () => ({
      html: "<!doctype html><body><h1>Retained Markdown</h1></body>",
      revision: "preview-fixture",
    }),
  });
  id = storage.artifacts.create({ kind: "html", actor }).id;
  await storage.artifacts.publish(id, {
    actor,
    publicationKey: "publication",
    expectedSeq: 0,
    content: {
      kind: "html",
      entrypoint: "index.html",
      files: [
        {
          path: "index.html",
          mediaType: "text/html",
          base64: Buffer.from(html).toString("base64"),
        },
        {
          path: "notes.md",
          mediaType: "text/markdown",
          base64: Buffer.from("# Original Markdown").toString("base64"),
        },
        {
          path: "data.bin",
          mediaType: "application/octet-stream",
          base64: Buffer.from([0, 255, 128, 3, 4]).toString("base64"),
        },
      ],
    },
  });
  host = new PreviewHost(storage.artifacts, "https://preview.example", {
    runtime: () => "/* r3 runtime fixture */",
    utility: () => "export const fixture = true;",
  });
  context = host.create(id, 1, "index.html", "https://app.example");
  const proof = host.contexts.challenge(req("/r3/gate"));
  host.contexts.verify(
    req("/r3/verify", {
      method: "POST",
      headers: { origin: "null", "content-type": "application/json" },
    }),
    proof.challenge,
  );
});
afterEach(async () => {
  host.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
});
function req(path: string, options: RequestInit = {}) {
  return new Request(context.resourceRoot.replace(/\/files\/$/, "") + path, {
    ...options,
    headers: {
      host: new URL(context.origin).host,
      "user-agent": "Preview fixture browser",
      ...options.headers,
    },
  });
}
function read(path: string, headers: Record<string, string> = {}, method = "GET") {
  return host.fetch(req(path, { method, headers: headers }));
}

test("files media uses an isolated wrapper without inlining executable SVG", async () => {
  const files = storage.artifacts.create({ kind: "files", actor });
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg"><script>window.publisherScript=true</script></svg>';
  await storage.artifacts.publish(files.id, {
    actor,
    publicationKey: "media",
    expectedSeq: 0,
    content: {
      kind: "files",
      files: [
        {
          path: "images/a & b.svg",
          mediaType: "image/svg+xml",
          base64: Buffer.from(svg).toString("base64"),
        },
      ],
    },
  });
  context = host.create(files.id, 1, "images/a & b.svg", "https://app.example");
  expect(context.presentation).toBe("media");
  const proof = host.contexts.challenge(req("/r3/gate"));
  host.contexts.verify(
    req("/r3/verify", {
      method: "POST",
      headers: { origin: "null", "content-type": "application/json" },
    }),
    proof.challenge,
  );
  const response = await read("/r3/media");
  const wrapper = await response.text();
  expect(wrapper).toContain('<img src="');
  expect(wrapper).toContain("/files/images/a%20%26%20b.svg");
  expect(wrapper).not.toContain("publisherScript");
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  expect(await (await read("/files/images/a%20%26%20b.svg")).text()).toBe(svg);
});

test("preview gate exposes only trusted support until that browser passes verification", async () => {
  const refused = await host.fetch(
    req("/files/index.html", {
      headers: { "sec-fetch-dest": "iframe", "user-agent": "Unverified browser" },
    }),
  );
  expect(refused.status).toBe(403);
  expect(await refused.text()).not.toContain(html);
  const gate = await host.fetch(req("/r3/gate"));
  expect(gate.headers.get("cache-control")).toBe("no-store");
  expect(gate.headers.has("access-control-allow-origin")).toBe(false);
  expect(gate.headers.has("set-cookie")).toBe(false);
  const page = await gate.text();
  expect(page).toContain("iceTransportPolicy");
  expect(page).toContain("/outside/check");
  expect(page).not.toContain("Published page");
  expect((await host.fetch(req("/outside/check"))).status).toBe(204);
  const changedBrowser = await read("/files/index.html", { "user-agent": "Different browser" });
  expect(changedBrowser.status).toBe(403);
  const forged = await host.fetch(
    req("/r3/verify", {
      method: "POST",
      headers: { origin: "https://app.example", "content-type": "application/json" },
      body: JSON.stringify({ challenge: crypto.randomUUID() }),
    }),
  );
  expect(forged.status).toBe(403);
});

test("published resources retain bytes, native MIME, private validators, and ranges", async () => {
  const file = await read("/files/data.bin");
  expect(file.headers.get("content-type")).toBe("application/octet-stream");
  expect(file.headers.get("access-control-allow-origin")).toBe("*");
  expect(file.headers.has("access-control-allow-credentials")).toBe(false);
  expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([0, 255, 128, 3, 4]);
  expect(file.headers.get("cache-control")).toContain("private");
  const range = await read("/files/data.bin", { range: "bytes=1-3" });
  expect(range.status).toBe(206);
  expect(range.headers.get("content-range")).toBe("bytes 1-3/5");
  expect([...new Uint8Array(await range.arrayBuffer())]).toEqual([255, 128, 3]);
  const head = await read("/files/data.bin", {}, "HEAD");
  expect(head.headers.get("content-length")).toBe("5");
  expect(await head.text()).toBe("");
  expect(
    (await read("/files/data.bin", { "if-none-match": file.headers.get("etag")! })).status,
  ).toBe(304);
  expect(await (await read("/files/index.html")).text()).toBe(html);
  expect(await (await read("/files/notes.md")).text()).toBe("# Original Markdown");
});

test("document navigation uses retained Markdown and injects only the r3 runtime", async () => {
  const document = await read("/files/index.html", { "sec-fetch-dest": "iframe" });
  const body = await document.text();
  expect(
    body.replace(
      /<script type="importmap">.*?<\/script><script src="[^"]+\/r3\/runtime.js"><\/script>/,
      "",
    ),
  ).toBe(html);
  expect(body.indexOf("/r3/runtime.js")).toBeLessThan(body.indexOf("<head>"));
  expect(document.headers.get("cache-control")).toBe("no-store");
  expect(document.headers.get("content-security-policy")).toContain(
    "frame-ancestors https://app.example",
  );
  expect(document.headers.get("connection-allowlist")).toContain("webrtc=block; redirects=block");
  expect(document.headers.get("vary")).toContain("Sec-Fetch-Dest");
  const markdown = await read("/files/notes.md", { "sec-fetch-dest": "iframe" });
  expect(markdown.headers.get("content-type")).toStartWith("text/html");
  expect(await markdown.text()).toContain("Retained Markdown");
  expect(await (await read("/r3/utility.js")).text()).toContain("export const fixture");
});

test("preview hosting never serves application routes, another version, service workers, or a history fallback", async () => {
  for (const path of [
    "/api/boot",
    "/api/artifacts",
    "/files/missing.html",
    "/app-route",
    "/files/http://outside.example/data",
    "/files/%2e%2e%2fapi/boot",
  ])
    expect((await read(path)).status).toBe(404);
  expect((await read("/r3/runtime.js", { "service-worker": "script" })).status).toBe(403);
  expect((await read("/files/index.html", { "sec-fetch-dest": "serviceworker" })).status).toBe(403);
  expect((await read("/files/index.html", {}, "POST")).status).toBe(405);
  expect((await read("/files/index.html", { "sec-fetch-dest": "document" })).status).toBe(403);
  const other = host.create(id, 1, "index.html", "https://app.example");
  const reused = new Request(other.documentUrl, {
    headers: { host: new URL(other.origin).host, "user-agent": "Preview fixture browser" },
  });
  expect((await host.fetch(reused)).status).toBe(403);
  host.revoke(context.id);
  expect((await read("/files/index.html")).status).toBe(404);
});
