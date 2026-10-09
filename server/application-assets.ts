import { createHash } from "node:crypto";
import type { HTMLBundle } from "bun";
import type { ApplicationBootstrap } from "../shared/types.ts";
import { acceptsGzip, gzipBody } from "./compress.ts";

export interface ApplicationAsset {
  body: Blob;
  contentType: string;
  etag: string;
}
export interface ApplicationAssets {
  index: ApplicationAsset;
  files: ReadonlyMap<string, ApplicationAsset>;
}

const isApplicationDocument = (path: string) =>
  path === "/" || path === "/authorize" || /^\/(?:artifact|review)_[\w]+\/?$/.test(path);

// Static assets retain immutable caching. Documents are per-request auth
// snapshots: never reuse a validator or a personalized body after logout.
export function createApplicationResponse(
  assets: ApplicationAssets,
  bootstrap: (request: Request) => ApplicationBootstrap | null,
) {
  const shell = assets.index.body.text();
  return async (request: Request): Promise<Response> => {
    if (
      !isApplicationDocument(new URL(request.url).pathname) ||
      !["GET", "HEAD"].includes(request.method)
    )
      return applicationAssetResponse(assets, request);
    const data = bootstrap(request);
    const base = applicationAssetResponse(assets, request);
    const headers = new Headers(base.headers);
    headers.set("Cache-Control", "private, no-store");
    headers.set("Vary", "Cookie, Accept-Encoding");
    headers.delete("ETag");
    let html = await shell;
    if (data) {
      const json = JSON.stringify(data).replaceAll("<", "\\u003c");
      const script = `<script id="r3-bootstrap" type="application/json">${json}</script>`;
      html = /<\/head>/i.test(html)
        ? html.replace(/<\/head>/i, () => `${script}</head>`)
        : html + script;
    }
    let body: Uint8Array<ArrayBuffer> = new TextEncoder().encode(html);
    if (body.byteLength >= 1024 && acceptsGzip(request)) {
      body = await gzipBody(body);
      headers.set("Content-Encoding", "gzip");
    }
    headers.set("Content-Length", String(body.byteLength));
    return new Response(request.method === "HEAD" ? null : body, { headers });
  };
}

// Both distributions use explicit HTTP responses so application frame/Host
// protections cannot be bypassed by a native static route. A compiled binary
// reads Bun's embedded files; a source daemon bundles the SPA once at startup.
export async function loadApplicationAssets(bundle: HTMLBundle): Promise<ApplicationAssets> {
  const files = new Map<string, ApplicationAsset>();
  let index: ApplicationAsset | undefined;
  if (bundle.files) {
    for (const file of bundle.files) {
      const asset = {
        body: Bun.file(file.path),
        contentType: file.headers["content-type"],
        etag: file.headers.etag,
      };
      if (file.loader === "html" && file.isEntry) index = asset;
      else files.set(`/${file.path.split("/").at(-1)}`, asset);
    }
  } else {
    const { browserLoweredCssPlugin } = await import("../scripts/spa-css.ts");
    const result = await Bun.build({
      entrypoints: [bundle.index],
      target: "browser",
      minify: true,
      define: { "process.env.NODE_ENV": '"production"' },
      plugins: [await browserLoweredCssPlugin()],
    });
    if (!result.success) throw new Error("Unable to build the r3 application assets");
    for (const output of result.outputs) {
      const bytes = await output.arrayBuffer();
      const asset = {
        body: new Blob([bytes]),
        contentType: output.type,
        etag: `"${createHash("sha256").update(new Uint8Array(bytes)).digest("hex")}"`,
      };
      if (output.path.endsWith(".html")) index = asset;
      else files.set(`/${output.path.split("/").at(-1)}`, asset);
    }
  }
  if (!index) throw new Error("The r3 application HTML is missing from the build");
  return { index, files };
}

export function applicationAssetResponse(assets: ApplicationAssets, request: Request): Response {
  const path = new URL(request.url).pathname;
  const document = isApplicationDocument(path);
  const asset = document ? assets.index : assets.files.get(path);
  const headers = new Headers({
    "Content-Security-Policy": "frame-ancestors 'none'; object-src 'none'; base-uri 'self'",
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": document ? "no-cache" : "public, max-age=31536000, immutable",
  });
  const empty = (status: number) => {
    headers.set("Cache-Control", "no-store");
    return new Response(null, { status, headers });
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    headers.set("Allow", "GET, HEAD");
    return empty(405);
  }
  if (!asset) return empty(404);
  headers.set("Content-Type", asset.contentType);
  headers.set("ETag", asset.etag);
  if (request.headers.get("if-none-match") === asset.etag)
    return new Response(null, { status: 304, headers });
  headers.set("Content-Length", String(asset.body.size));
  return new Response(request.method === "HEAD" ? null : asset.body, { headers });
}
