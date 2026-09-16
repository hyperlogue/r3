import { createHash } from "node:crypto";
import { ArtifactError, requireObject } from "./artifact-validation.ts";
import { gzipBody } from "./compress.ts";

// Count actual bytes, including chunked bodies and misleading Content-Length.
// Call after authentication so an unauthenticated upload is never buffered.
export async function artifactJson(request: Request, limit = 2 * 1024 * 1024) {
  if (!request.headers.get("content-type")?.match(/^application\/json(?:\s*;|$)/i))
    throw new ArtifactError("Request body must be application/json");
  const reader = request.body?.getReader();
  if (!reader) throw new ArtifactError("Missing JSON body");
  let size = 0;
  const chunks: Uint8Array[] = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        void reader.cancel().catch(() => {});
        throw new ArtifactError("Request body is too large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new ArtifactError("Invalid JSON body");
  }
  return requireObject(value, "Request body");
}

// Content-derived validators work for both immutable content and mutable detail.
// Keep compression off the event loop for large highlighted responses.
export function matchesEntityTag(request: Request, etag: string): boolean {
  return (
    request.headers
      .get("if-none-match")
      ?.split(",")
      .some((tag) => {
        const candidate = tag.trim();
        return candidate === "*" || candidate.replace(/^W\//, "") === etag.replace(/^W\//, "");
      }) ?? false
  );
}

export async function artifactJsonResponse(
  request: Request,
  value: unknown,
  validator?: string,
): Promise<Response> {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-cache",
    Vary: "Accept-Encoding",
  });
  if (validator) {
    headers.set("ETag", validator);
    if (matchesEntityTag(request, validator)) return new Response(null, { status: 304, headers });
  }
  let body = new TextEncoder().encode(
    JSON.stringify(typeof value === "function" ? await value() : value),
  );
  const etag = validator ?? `W/"${createHash("sha256").update(body).digest("hex")}"`;
  headers.set("ETag", etag);
  if (matchesEntityTag(request, etag)) return new Response(null, { status: 304, headers });
  const gzip = request.headers
    .get("accept-encoding")
    ?.split(",")
    .some((entry) => {
      const [coding, ...parameters] = entry.trim().split(";");
      const quality = parameters.find((part) => part.trim().startsWith("q="));
      return coding === "gzip" && (quality === undefined || Number(quality.trim().slice(2)) > 0);
    });
  if (body.byteLength >= 1024 && gzip) {
    body = await gzipBody(body);
    headers.set("Content-Encoding", "gzip");
  }
  headers.set("Content-Length", String(body.byteLength));
  return new Response(request.method === "HEAD" ? null : body, { headers });
}
