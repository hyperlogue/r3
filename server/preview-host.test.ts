import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
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
  const response = await read("/r3/media");
  const wrapper = await response.text();
  expect(wrapper).toContain('<img src="');
  expect(wrapper).toContain("/files/images/a%20%26%20b.svg");
  expect(wrapper).not.toContain("publisherScript");
  expect(response.headers.get("content-security-policy")).toContain("sandbox");
  expect(await (await read("/files/images/a%20%26%20b.svg")).text()).toBe(svg);
});

test("the workspace gate checks browser capabilities without a server challenge", async () => {
  const gate = await read("/r3/gate");
  expect(gate.headers.get("cache-control")).toBe("no-store");
  expect(gate.headers.has("access-control-allow-origin")).toBe(false);
  expect(gate.headers.has("set-cookie")).toBe(false);
  const page = await gate.text();
  expect(page).toContain("iceTransportPolicy");
  expect(page).toContain("/outside/check");
  expect(page).not.toContain("Published page");
  expect(page).not.toContain("/r3/verify");
  expect((await read("/outside/check")).status).toBe(204);
  expect((await read("/r3/verify")).status).toBe(404);
  for (const method of ["POST", "OPTIONS"])
    expect((await read("/r3/verify", { origin: "null" }, method)).status).toBe(405);

  // Possession of the scoped capability authorizes bytes. The workspace, not a
  // User-Agent registration, decides when to execute publisher content.
  const document = await read("/files/index.html", {
    "sec-fetch-dest": "iframe",
    "user-agent": "Different browser",
    origin: "null",
  });
  expect(document.status).toBe(200);
  expect(await document.text()).toContain("Published page");
  expect(document.headers.has("set-cookie")).toBe(false);
  const unknown = new URL(context.documentUrl);
  unknown.pathname = unknown.pathname.replace(context.id, `p${randomBytes(24).toString("hex")}`);
  expect(
    (await host.fetch(new Request(unknown, { headers: { host: unknown.host, origin: "null" } })))
      .status,
  ).toBe(404);
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

test("external HTML contexts retain browser checks, sandbox, membership, and revocation", async () => {
  context = host.create(id, 1, "index.html", "https://app.example", "external");
  const gate = await read("/r3/gate");
  expect(gate.headers.has("access-control-allow-origin")).toBe(false);
  expect(await gate.text()).toContain('"network":"external"');
  const document = await read("/files/index.html", { "sec-fetch-dest": "iframe" });
  expect(document.status).toBe(200);
  expect(document.headers.has("connection-allowlist")).toBe(false);
  expect(document.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
  expect(document.headers.get("permissions-policy")).toBe("camera=(), microphone=()");
  expect(await document.text()).toContain("Published page");
  expect((await read("/files/index.html", { "sec-fetch-dest": "document" })).status).toBe(403);
  expect((await read("/r3/runtime.js", { "service-worker": "script" })).status).toBe(403);
  expect((await read("/api/artifacts")).status).toBe(404);
  host.revoke(context.id);
  expect((await read("/files/index.html")).status).toBe(404);
});

test("HTML receives the runtime and Markdown receives an isolated empty shell", async () => {
  const document = await read("/files/index.html", { "sec-fetch-dest": "iframe" });
  const body = await document.text();
  expect(
    body.replace(
      /<script type="importmap">.*?<\/script><script src="[^"]+\/r3\/runtime.js"><\/script>/,
      "",
    ),
  ).toBe(html);
  expect(body.indexOf("/r3/runtime.js")).toBeLessThan(body.indexOf("<head>"));
  expect(document.headers.get("cache-control")).toBe("private, no-cache");
  expect(document.headers.get("content-security-policy")).toContain(
    "frame-ancestors https://app.example",
  );
  expect(document.headers.get("connection-allowlist")).toContain("webrtc=block; redirects=block");
  expect(document.headers.get("vary")).toContain("Sec-Fetch-Dest");
  const markdown = await read("/files/notes.md", { "sec-fetch-dest": "iframe" });
  expect(markdown.headers.get("content-type")).toStartWith("text/html");
  const shell = await markdown.text();
  expect(shell).toContain("data-r3-markdown-shell");
  expect(shell).not.toContain("Retained Markdown");
  expect(await (await read("/r3/utility.js")).text()).toContain("export const fixture");
});

test("preview hosting never serves application routes, another version, service workers, or a history fallback", async () => {
  await storage.artifacts.publish(id, {
    actor,
    publicationKey: "later-publication",
    expectedSeq: 1,
    content: {
      kind: "html",
      files: [
        {
          path: "index.html",
          mediaType: "text/html",
          base64: Buffer.from("New page").toString("base64"),
        },
        {
          path: "later.txt",
          mediaType: "text/plain",
          base64: Buffer.from("New file").toString("base64"),
        },
      ],
    },
  });
  expect(await (await read("/files/index.html")).text()).toBe(html);
  for (const path of [
    "/api/boot",
    "/api/artifacts",
    "/files/missing.html",
    "/files/later.txt",
    "/app-route",
    "/files/http://outside.example/data",
    "/files/%2e%2e%2fapi/boot",
  ])
    expect((await read(path)).status).toBe(404);
  expect((await read("/r3/runtime.js", { "service-worker": "script" })).status).toBe(403);
  expect((await read("/files/index.html", { "sec-fetch-dest": "serviceworker" })).status).toBe(403);
  expect((await read("/files/index.html", {}, "POST")).status).toBe(405);
  expect((await read("/files/index.html", { "sec-fetch-dest": "document" })).status).toBe(403);
  host.revoke(context.id);
  expect((await read("/files/index.html")).status).toBe(404);
});

test("cached HTML and Markdown revalidate without blob reads and preserve navigation and revocation guards", async () => {
  for (const path of ["index.html", "notes.md"]) {
    const document = await read(`/files/${path}`, { "sec-fetch-dest": "iframe" });
    const headers = { "sec-fetch-dest": "iframe", "if-none-match": document.headers.get("etag")! };
    const original = storage.artifacts.resource;
    storage.artifacts.resource = () => {
      throw new Error("Unexpected blob access");
    };
    try {
      const reused = await read(`/files/${path}`, headers);
      expect(reused.status).toBe(304);
      expect(await reused.text()).toBe("");
      expect(reused.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
      expect(reused.headers.get("connection-allowlist")).toContain(context.id);
      expect(
        (await read(`/files/${path}`, { ...headers, "user-agent": "Different browser" })).status,
      ).toBe(304);
      expect(reused.headers.get("vary")).toBe("Sec-Fetch-Dest");
      expect(
        (await read(`/files/${path}`, { ...headers, "sec-fetch-dest": "document" })).status,
      ).toBe(403);
    } finally {
      storage.artifacts.resource = original;
    }
  }
  const document = await read("/files/index.html", { "sec-fetch-dest": "iframe" });
  host.revoke(context.id);
  expect(
    (
      await read("/files/index.html", {
        "sec-fetch-dest": "iframe",
        "if-none-match": document.headers.get("etag")!,
      })
    ).status,
  ).toBe(404);
});

test("only retained Markdown receives the workspace appearance adapter", async () => {
  const markdown = await read("/files/notes.md", { "sec-fetch-dest": "iframe" });
  expect(await markdown!.text()).toContain("<script data-r3-markdown data-r3-markdown-shell src=");
  const authored = await read("/files/index.html", { "sec-fetch-dest": "iframe" });
  expect(await authored!.text()).not.toContain("data-r3-markdown");
  const source = await read("/files/notes.md");
  expect(await source!.text()).toBe("# Original Markdown");
});

test("retained Markdown bytes require a live scoped capability and never execute as a document", async () => {
  const retained = await read("/r3/markdown?path=notes.md", { origin: "null" });
  expect(retained.status).toBe(200);
  expect(await retained.text()).toBe("<!doctype html><body><h1>Retained Markdown</h1></body>");
  expect(retained.headers.get("content-type")).toBe("text/plain; charset=utf-8");
  expect(retained.headers.get("content-disposition")).toBe("attachment");
  expect(retained.headers.get("cache-control")).toBe("no-store");
  expect(retained.headers.get("access-control-allow-origin")).toBe("*");
  expect(retained.headers.has("access-control-allow-credentials")).toBe(false);
  expect((await read("/r3/markdown?path=notes.md", { "sec-fetch-dest": "document" })).status).toBe(
    403,
  );
  expect(
    (await read("/r3/markdown?path=notes.md", { "sec-fetch-dest": "serviceworker" })).status,
  ).toBe(403);
  expect((await read("/r3/markdown?path=index.html")).status).toBe(404);
  expect((await read("/r3/markdown?path=missing.md")).status).toBe(404);
  expect((await read("/r3/markdown?path=..%2Fnotes.md")).status).toBe(400);
  host.revoke(context.id);
  expect((await read("/r3/markdown?path=notes.md")).status).toBe(404);
});

test("preview support revalidates its bytes without bypassing navigation or context guards", async () => {
  const validators = new Map<string, string>();
  for (const path of ["/r3/runtime.js", "/r3/utility.js"]) {
    const first = await read(path, { "sec-fetch-dest": "script" });
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("private, no-cache");
    const etag = first.headers.get("etag")!;
    expect(etag).toBeTruthy();
    validators.set(path, etag);
    const headers = { "sec-fetch-dest": "script", "if-none-match": etag };
    const reused = await read(path, headers);
    expect(reused.status).toBe(304);
    expect(await reused.text()).toBe("");
    expect(reused.headers.get("access-control-allow-origin")).toBe("*");
    expect(reused.headers.get("content-security-policy")).toContain("sandbox allow-scripts");
    expect((await read(path, { ...headers, "user-agent": "Different browser" })).status).toBe(304);
    expect(reused.headers.get("vary")).toBe("Sec-Fetch-Dest");
    expect((await read(path, { ...headers, "sec-fetch-dest": "document" })).status).toBe(403);
    expect((await read(path, { ...headers, "service-worker": "script" })).status).toBe(403);
  }
  expect(validators.get("/r3/runtime.js")).not.toBe(validators.get("/r3/utility.js"));
  expect(
    (await read("/r3/runtime.js", { "if-none-match": validators.get("/r3/utility.js")! })).status,
  ).toBe(200);
  host.revoke(context.id);
  for (const [path, etag] of validators)
    expect((await read(path, { "if-none-match": etag })).status).toBe(404);
});
