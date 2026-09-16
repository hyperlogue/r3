import { createHash } from "node:crypto";
import { type ArtifactPreviewContext, artifactMediaKind } from "../shared/artifacts.ts";
import { artifactJson, matchesEntityTag } from "./artifact-http.ts";
import { artifactResourceResponse } from "./artifact-resources.ts";
import { ArtifactError, requireArtifactPath } from "./artifact-validation.ts";
import type { ArtifactStore } from "./artifacts.ts";
import {
  PreviewContexts,
  type PreviewScope,
  previewDocumentUrl,
  previewPolicy,
  previewRoot,
} from "./preview-contexts.ts";
import { previewGateDocument } from "./preview-gate.ts";

export interface PreviewSupport {
  runtime(scope: PreviewScope): string;
  utility(scope: PreviewScope): string;
}

// The host owns only immutable published resources and r3 preview support.
// It has no application routes, upstream fetch, repo, filesystem path, or shell.
export class PreviewHost {
  readonly contexts: PreviewContexts;
  constructor(
    private readonly artifacts: ArtifactStore,
    baseUrl: string | undefined,
    private readonly support: PreviewSupport,
    now?: () => number,
  ) {
    this.contexts = new PreviewContexts(artifacts, baseUrl, now);
  }
  create(
    artifactId: string,
    seq: number,
    path: string,
    applicationOrigin: string,
    network?: unknown,
  ): ArtifactPreviewContext {
    return this.contexts.create(artifactId, seq, path, applicationOrigin, network);
  }
  renew(id: string): ArtifactPreviewContext {
    return this.contexts.renew(id);
  }
  revoke(id: string): void {
    this.contexts.revoke(id);
  }
  revokeArtifact(id: string): void {
    this.contexts.revokeArtifact(id);
  }
  close(): void {
    this.contexts.close();
  }

  async fetch(request: Request, applicationOrigins?: ReadonlySet<string>): Promise<Response> {
    let scope: PreviewScope;
    try {
      scope = this.contexts.forRequest(request, applicationOrigins);
      // Only the Host-guarded application listener supplies configured origins.
      // Normalize a known reverse proxy's rewritten Host after scope validation;
      // never derive a trusted origin from arbitrary forwarded request headers.
      if (request.headers.get("host") !== new URL(scope.origin).host) {
        const headers = new Headers(request.headers);
        headers.set("host", new URL(scope.origin).host);
        request = new Request(request, { headers });
      }
    } catch {
      return new Response("Preview context expired or unavailable", {
        status: 404,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'none'; sandbox",
          "x-content-type-options": "nosniff",
        },
      });
    }
    const policy = previewPolicy(scope);
    // Resource errors need the same credential-free CORS contract as successful
    // reads, so a missing published asset stays a visible 404. Gate HTML never
    // enters this namespace and must remain unreadable to opaque fetches.
    if (new URL(request.url).pathname.startsWith(`${new URL(previewRoot(scope)).pathname}/files/`))
      policy.set("access-control-allow-origin", "*");
    try {
      const response = await this.respond(request, scope);
      for (const [name, value] of policy) response.headers.set(name, value);
      return response;
    } catch (error) {
      policy.set("content-type", "text/plain; charset=utf-8");
      policy.set("cache-control", "no-store");
      return new Response(
        error instanceof ArtifactError ? error.message : "Preview request failed",
        { status: error instanceof ArtifactError ? error.status : 500, headers: policy },
      );
    }
  }

  private async respond(request: Request, scope: PreviewScope): Promise<Response> {
    const root = previewRoot(scope);
    const path = new URL(request.url).pathname.slice(new URL(root).pathname.length);
    const plain = (body: string | null, status = 200, headers: HeadersInit = {}) =>
      new Response(request.method === "HEAD" ? null : body, {
        status,
        headers: {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store",
          ...headers,
        },
      });
    if (path === "/r3/verify") {
      // An opaque Origin is shared by unrelated sandboxes. Authorization comes
      // from the unreadable gate's single-use challenge, never from CORS.
      const cors = { "access-control-allow-origin": "null" };
      if (request.method === "OPTIONS")
        return request.headers.get("origin") === "null" &&
          request.headers.get("access-control-request-method") === "POST" &&
          request.headers.get("access-control-request-headers")?.toLowerCase() === "content-type"
          ? plain(null, 204, {
              ...cors,
              "access-control-allow-methods": "POST",
              "access-control-allow-headers": "content-type",
            })
          : plain(null, 403);
      if (request.method !== "POST") return plain(null, 405, { allow: "POST" });
      const input = await artifactJson(request, 4096);
      if (typeof input.challenge !== "string") return plain("Invalid verification", 400);
      return this.contexts.verify(request, input.challenge)
        ? plain("Verified", 200, cors)
        : plain("Invalid verification", 403, cors);
    }
    if (request.method !== "GET" && request.method !== "HEAD")
      return plain(null, 405, { allow: "GET, HEAD" });
    // The blocked check really responds. Success means the browser ignored the
    // allowlist; a 404 or an intentionally broken address is not a policy proof.
    if (path === "/r3/check" || path === "/outside/check")
      return plain(null, 204, { "access-control-allow-origin": "*" });
    if (path === "/r3/gate") {
      const { challenge } = this.contexts.challenge(request);
      return plain(previewGateDocument(scope, challenge), 200, {
        "content-type": "text/html; charset=utf-8",
      });
    }
    if (!this.contexts.authorized(request))
      return plain("Open this artifact from r3 to verify this browser before rendering.", 403);
    // Bare navigation must never turn a shared URL into an unverified page in
    // another browser. Published documents are opened inside the r3 workspace.
    if (request.headers.get("sec-fetch-dest") === "document")
      return plain("Open this artifact from r3 to render it.", 403);
    // Service workers could substitute their own document responses and remove
    // the server's policy. No publisher script may register as a service worker.
    if (
      request.headers.get("service-worker") === "script" ||
      request.headers.get("sec-fetch-dest") === "serviceworker"
    )
      return plain("Service workers are unavailable in artifact previews", 403);
    if (path === "/r3/runtime.js" || path === "/r3/utility.js")
      return plain(
        path.endsWith("runtime.js") ? this.support.runtime(scope) : this.support.utility(scope),
        200,
        { "content-type": "text/javascript; charset=utf-8", "access-control-allow-origin": "*" },
      );
    if (path === "/r3/media" && scope.presentation === "media") {
      const file = this.artifacts.file(scope.artifactId, scope.versionSeq, scope.entryPath);
      const kind = artifactMediaKind(file.mediaType);
      if (!kind) return plain("Media resource not found", 404);
      const tag = kind === "image" ? "img" : kind;
      // SVG bytes are an image resource on the isolated origin, never inline
      // markup or an application-origin blob document.
      const src = previewDocumentUrl(scope, scope.entryPath)
        .replaceAll("&", "&amp;")
        .replaceAll('"', "&quot;");
      return plain(
        `<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Media preview</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#171717}img,video{max-width:100%;max-height:100vh}audio{width:min(90%,40rem)}</style><${tag} src="${src}" ${kind === "image" ? 'alt="Published image"' : 'controls preload="metadata"'}></${tag}><script src="${root}/r3/runtime.js"></script></html>`,
        200,
        { "content-type": "text/html; charset=utf-8" },
      );
    }
    if (!path.startsWith("/files/")) return plain("Published resource not found", 404);
    let filePath: string;
    try {
      filePath = requireArtifactPath(decodeURIComponent(path.slice("/files/".length)));
    } catch {
      return plain("Published resource not found", 404);
    }
    const file = this.artifacts.file(scope.artifactId, scope.versionSeq, filePath);
    const destination = request.headers.get("sec-fetch-dest");
    const document =
      destination === "document" || destination === "iframe" || destination === "frame";
    const html = document && (!!file.renderedHash || file.mediaType.split(";")[0] === "text/html");
    // A retained document is immutable, but its executable response includes
    // context-scoped support and policy. Revalidate after authorization, before
    // reading or rewriting any published bytes.
    const etag = html
      ? `W/"${createHash("sha256")
          .update(
            JSON.stringify([
              "r3-preview-1",
              file.renderedHash ?? file.hash,
              !!file.renderedHash,
              scope.id,
              this.support.runtime(scope),
              this.support.utility(scope),
              [...previewPolicy(scope)],
            ]),
          )
          .digest("hex")}"`
      : null;
    const documentHeaders = {
      "cache-control": "private, no-cache",
      "content-type": "text/html; charset=utf-8",
      vary: "User-Agent, Sec-Fetch-Dest",
      etag: etag ?? "",
    };
    if (etag && matchesEntityTag(request, etag))
      return new Response(null, { status: 304, headers: documentHeaders });
    let readRequest = request;
    if (html) {
      const headers = new Headers(request.headers);
      for (const name of ["range", "if-range", "if-none-match"]) headers.delete(name);
      readRequest = new Request(request.url, { method: request.method, headers });
    }
    const response = await artifactResourceResponse(
      this.artifacts,
      readRequest,
      scope.artifactId,
      scope.versionSeq,
      filePath,
      { inline: true, rendered: document && !!file.renderedHash },
    );
    response.headers.set("vary", "User-Agent, Sec-Fetch-Dest");
    if (!html) {
      response.headers.set("access-control-allow-origin", "*");
      return response;
    }
    // Keep original and retained Markdown bytes unchanged in storage. The
    // response adds trusted support before publisher scripts.
    for (const [name, value] of Object.entries(documentHeaders)) response.headers.set(name, value);
    for (const name of ["content-length", "accept-ranges"]) response.headers.delete(name);
    if (request.method === "HEAD") return response;
    let injected = false;
    // Retain the established utility import without rewriting publisher assets.
    const imports = JSON.stringify({ imports: { "/r3/utility.js": `${root}/r3/utility.js` } });
    const runtime = `<script type="importmap">${imports}</script><script${file.renderedHash ? " data-r3-markdown" : ""} src="${root}/r3/runtime.js"></script>`;
    return new HTMLRewriter()
      .on("*", {
        element(element) {
          if (injected || element.tagName === "html") return;
          injected = true;
          element.before(runtime, { html: true });
        },
      })
      .onDocument({
        end(end) {
          if (!injected) end.append(runtime, { html: true });
        },
      })
      .transform(response);
  }
}
