import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ApplicationAssets,
  applicationAssetResponse,
  loadApplicationAssets,
} from "./application-assets.ts";

test("application bytes have frame protections and only artifact routes get the shell", async () => {
  const assets: ApplicationAssets = {
    index: {
      body: new Blob(["<!doctype html><title>r3</title>"]),
      contentType: "text/html",
      etag: '"shell"',
    },
    files: new Map([
      [
        "/chunk-fixture.js",
        {
          body: new Blob(["const fixture = true;"]),
          contentType: "text/javascript",
          etag: '"script"',
        },
      ],
    ]),
  };
  const read = (path: string, options?: RequestInit) =>
    applicationAssetResponse(assets, new Request(`http://localhost${path}`, options));
  for (const path of ["/", "/artifact_fixture", "/review_imported"]) {
    const response = read(path);
    expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(await response.text()).toContain("<title>r3</title>");
  }
  for (const path of [
    "/api/missing",
    "/files/index.html",
    "/chunk-missing.js",
    "/artifact_fixture/anything",
  ])
    expect(read(path).status).toBe(404);
  expect(read("/", { method: "POST" }).status).toBe(405);
  expect(await read("/chunk-fixture.js", { method: "HEAD" }).text()).toBe("");
  expect(read("/chunk-fixture.js", { headers: { "if-none-match": '"script"' } }).status).toBe(304);
});

test("bundled assets negotiate cached gzip bytes with representation-specific validators", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-asset-compression-"));
  const script = "export const content = 'published application';\n".repeat(1000);
  const stylesheet = ".fixture { color: purple; background: white; }\n".repeat(100);
  try {
    const fixtures = [
      {
        name: "index.html",
        loader: "html" as const,
        type: "text/html",
        bytes: "<title>r3</title>",
      },
      { name: "app.js", loader: "js" as const, type: "text/javascript", bytes: script },
      { name: "app.css", loader: "css" as const, type: "text/css", bytes: stylesheet },
      {
        name: "image.png",
        loader: "file" as const,
        type: "image/png",
        bytes: "image".repeat(1000),
      },
    ];
    for (const fixture of fixtures) await writeFile(join(root, fixture.name), fixture.bytes);
    const assets = await loadApplicationAssets({
      index: join(root, "index.html"),
      files: fixtures.map((fixture) => ({
        path: join(root, fixture.name),
        loader: fixture.loader,
        isEntry: fixture.name === "index.html",
        headers: { "content-type": fixture.type, etag: `"${fixture.name}"` },
      })),
    });
    const read = (path: string, headers: HeadersInit = {}, method = "GET") =>
      applicationAssetResponse(
        assets,
        new Request(`http://localhost/${path}`, { method, headers }),
      );
    for (const [path, original] of [
      ["app.js", script],
      ["app.css", stylesheet],
    ]) {
      const identity = read(path);
      expect(await identity.text()).toBe(original);
      expect(identity.headers.get("content-encoding")).toBeNull();
      const gzip = read(path, { "accept-encoding": "gzip, br" });
      expect(gzip.headers.get("content-encoding")).toBe("gzip");
      expect(gzip.headers.get("vary")).toBe("Accept-Encoding");
      expect(gzip.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect(gzip.headers.get("x-frame-options")).toBe("DENY");
      const encoded = new Uint8Array(await gzip.arrayBuffer());
      expect(new TextDecoder().decode(Bun.gunzipSync(encoded))).toBe(original);
      expect(encoded.byteLength).toBeLessThan(original.length / 2);
      expect(gzip.headers.get("content-length")).toBe(String(encoded.byteLength));
      const gzipTag = gzip.headers.get("etag")!;
      expect(gzipTag).not.toBe(identity.headers.get("etag"));
      const head = read(path, { "accept-encoding": "gzip" }, "HEAD");
      expect(await head.text()).toBe("");
      expect(head.headers.get("content-length")).toBe(String(encoded.byteLength));
      expect(head.headers.get("etag")).toBe(gzipTag);
      const cached = read(path, { "accept-encoding": "gzip", "if-none-match": gzipTag });
      expect(cached.status).toBe(304);
      expect(cached.headers.get("vary")).toBe("Accept-Encoding");
      expect(await cached.text()).toBe("");
      expect(read(path, { "if-none-match": gzipTag }).status).toBe(200);
      expect(
        read(path, { "accept-encoding": "gzip", "if-none-match": identity.headers.get("etag")! })
          .status,
      ).toBe(200);
      expect(
        read(path, { "accept-encoding": "gzip;q=0, br" }).headers.get("content-encoding"),
      ).toBeNull();
    }
    expect(
      read("image.png", { "accept-encoding": "gzip" }).headers.get("content-encoding"),
    ).toBeNull();
    expect(read("index.html", { "accept-encoding": "gzip" }).status).toBe(404);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
