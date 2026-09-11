import type { ArtifactPreviewContext } from "../shared/artifacts.ts";
import { artifactJson } from "./artifact-http.ts";
import { artifactResourceResponse } from "./artifact-resources.ts";
import { ArtifactError, requireArtifactPath } from "./artifact-validation.ts";
import type { ArtifactStore } from "./artifacts.ts";
import { PreviewContexts, type PreviewScope, previewPolicy } from "./preview-contexts.ts";
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
    baseUrl: string,
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
  ): ArtifactPreviewContext {
    return this.contexts.create(artifactId, seq, path, applicationOrigin);
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

  async fetch(request: Request): Promise<Response> {
    let scope: PreviewScope;
    try {
      scope = this.contexts.forRequest(request);
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
    const path = new URL(request.url).pathname;
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
      if (request.method !== "POST") return plain(null, 405, { allow: "POST" });
      const input = await artifactJson(request, 4096);
      if (typeof input.challenge !== "string") return plain("Invalid verification", 400);
      const cookie = this.contexts.verify(request, input.challenge);
      return cookie
        ? plain("Verified", 200, { "set-cookie": cookie })
        : plain("Invalid verification", 403);
    }
    if (request.method !== "GET" && request.method !== "HEAD")
      return plain(null, 405, { allow: "GET, HEAD" });
    // The blocked check really responds. Success means the browser ignored the
    // allowlist; a 404 or an intentionally broken address is not a policy proof.
    if (path === "/r3/check" || path === "/outside/check") return plain(null, 204);
    if (path === "/r3/gate") {
      const { challenge } = this.contexts.challenge(request);
      return plain(previewGateDocument(scope, challenge), 200, {
        "content-type": "text/html; charset=utf-8",
      });
    }
    if (!this.contexts.authorized(request))
      return plain("Open this artifact from r3 to verify this browser before rendering.", 403);
    if (path === "/r3/verified") return plain(null, 204);
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
        { "content-type": "text/javascript; charset=utf-8" },
      );
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
    response.headers.set(
      "vary",
      "Cookie, User-Agent, Sec-CH-UA, Sec-CH-UA-Platform, Sec-Fetch-Dest",
    );
    if (!html) return response;
    // Keep original and retained Markdown bytes unchanged in storage. The
    // response adds only the preview runtime, after the publisher's document.
    response.headers.set("cache-control", "no-store");
    for (const name of ["etag", "content-length", "accept-ranges"]) response.headers.delete(name);
    if (request.method === "HEAD") return response;
    return new HTMLRewriter()
      .onDocument({
        end(end) {
          end.append('<script src="/r3/runtime.js"></script>', { html: true });
        },
      })
      .transform(response);
  }
}
