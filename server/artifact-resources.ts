import type { ArtifactStore } from "./artifacts.ts";

export interface StoredResource {
  hash: string;
  byteLength: number;
  mediaType: string;
  read(): Promise<Uint8Array<ArrayBuffer>>;
  readRange(start: number, end: number): Promise<ReadableStream<Uint8Array>>;
}

function rangeFor(value: string, length: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || (!match[1] && !match[2]) || length === 0) return null;
  const first = match[1] ? Number(match[1]) : null;
  const last = match[2] ? Number(match[2]) : null;
  if (
    (first !== null && !Number.isSafeInteger(first)) ||
    (last !== null && !Number.isSafeInteger(last))
  )
    return null;
  if (first === null) {
    if (!last) return null;
    return { start: Math.max(0, length - last), end: length - 1 };
  }
  const end = Math.min(length - 1, last ?? length - 1);
  return first > end ? null : { start: first, end };
}

// The application uses the default attachment response. Only the isolated
// preview server may choose inline, after adding its origin/network policy.
export async function resourceResponse(
  request: Request,
  find: () => StoredResource,
  options: { filename: string; inline?: boolean },
): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD")
    return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const resource = find();
  const etag = `"${resource.hash}"`;
  const headers = new Headers({
    "Content-Type": resource.mediaType,
    "Cache-Control": "private, max-age=31536000, immutable",
    ETag: etag,
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
  });
  if (!options.inline) {
    const name = encodeURIComponent(options.filename).replace(
      /[!'()*]/g,
      (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
    );
    headers.set("Content-Disposition", `attachment; filename*=UTF-8''${name}`);
    headers.set("Content-Security-Policy", "sandbox; default-src 'none'; frame-ancestors 'none'");
  }
  const validators = request.headers
    .get("if-none-match")
    ?.split(",")
    .map((value) => value.trim().replace(/^W\//, ""));
  if (validators?.some((value) => value === "*" || value === etag))
    return new Response(null, { status: 304, headers });
  const range = request.headers.get("range");
  const ifRange = request.headers.get("if-range");
  const selection =
    request.method === "GET" && range?.startsWith("bytes=") && (!ifRange || ifRange === etag)
      ? rangeFor(range, resource.byteLength)
      : undefined;
  if (selection === null) {
    headers.set("Content-Range", `bytes */${resource.byteLength}`);
    headers.set("Content-Length", "0");
    return new Response(null, { status: 416, headers });
  }
  const length = selection ? selection.end - selection.start + 1 : resource.byteLength;
  headers.set("Content-Length", String(length));
  if (selection)
    headers.set(
      "Content-Range",
      `bytes ${selection.start}-${selection.end}/${resource.byteLength}`,
    );
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  const body = selection
    ? await resource.readRange(selection.start, selection.end)
    : await resource.read();
  return new Response(body, { status: selection ? 206 : 200, headers });
}

export function artifactResourceResponse(
  store: ArtifactStore,
  request: Request,
  artifactId: string,
  seq: number,
  path: string,
  options: { rendered?: boolean; inline?: boolean } = {},
): Promise<Response> {
  return resourceResponse(request, () => store.resource(artifactId, seq, path, options.rendered), {
    filename: path.split("/").at(-1)!,
    inline: options.inline,
  });
}
