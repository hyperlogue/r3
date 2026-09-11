import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import type { ArtifactPreviewContext } from "../shared/artifacts.ts";
import { ArtifactError, requireArtifactPath } from "./artifact-validation.ts";
import type { ArtifactStore } from "./artifacts.ts";

const CONTEXT_TTL = 60 * 60 * 1000;
const MAX_CONTEXTS = 512;

function secureOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ArtifactError("Invalid preview or application origin");
  }
  const local =
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "[::1]" ||
    (isIP(url.hostname) === 4 && url.hostname.startsWith("127."));
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new ArtifactError(
      "Preview hosting requires an HTTPS origin or an HTTP loopback origin, without credentials or a URL path",
    );
  return url;
}

export interface PreviewScope {
  readonly id: string;
  readonly artifactId: string;
  readonly versionSeq: number;
  readonly origin: string;
  readonly applicationOrigin: string;
  readonly entryPath: string;
  readonly expiresAt: number;
}

export function previewDocumentUrl(scope: Pick<PreviewScope, "origin">, path: string): string {
  requireArtifactPath(path);
  return `${scope.origin}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
}

// Context identities live only in this daemon instance. No cookie or master
// credential is copied to the preview; native resource requests use its unique
// capability origin. Host/port matching precedes every preview response.
export class PreviewContexts {
  private readonly contexts = new Map<string, PreviewScope>();
  private readonly base: URL;
  constructor(
    private readonly artifacts: ArtifactStore,
    baseUrl: string,
    private readonly now: () => number = Date.now,
  ) {
    this.base = secureOrigin(baseUrl);
    if (
      this.base.hostname.length > 203 ||
      !this.base.hostname
        .split(".")
        .every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)) ||
      this.base.hostname.split(".").every((part) => /^\d+$/.test(part))
    )
      throw new ArtifactError(
        "Preview hosting needs a DNS hostname that supports context subdomains",
      );
  }

  create(
    artifactId: string,
    versionSeq: number,
    path: string,
    applicationOrigin: string,
  ): ArtifactPreviewContext {
    const app = secureOrigin(applicationOrigin);
    const version = this.artifacts.version(artifactId, versionSeq);
    if (version.kind === "diff")
      throw new ArtifactError("Diff publications have no rendered preview");
    const file = this.artifacts.file(artifactId, versionSeq, requireArtifactPath(path));
    if (!file.renderedHash && file.mediaType.split(";")[0] !== "text/html")
      throw new ArtifactError("This publication has no rendered document at that path");
    this.expire();
    if (this.contexts.size >= MAX_CONTEXTS)
      throw new ArtifactError("Too many open preview contexts", 413);
    const id = `p${randomBytes(24).toString("hex")}`;
    const origin = `${this.base.protocol}//${id}.${this.base.host}`;
    if (app.origin === origin || app.hostname.endsWith(`.${this.base.hostname}`))
      throw new ArtifactError("The preview domain cannot host the r3 application");
    const scope: PreviewScope = Object.freeze({
      id,
      artifactId,
      versionSeq,
      entryPath: path,
      origin,
      applicationOrigin: app.origin,
      expiresAt: this.now() + CONTEXT_TTL,
    });
    this.contexts.set(id, scope);
    return this.describe(scope);
  }

  private describe(scope: PreviewScope): ArtifactPreviewContext {
    return {
      id: scope.id,
      artifactId: scope.artifactId,
      versionSeq: scope.versionSeq,
      origin: scope.origin,
      documentUrl: previewDocumentUrl(scope, scope.entryPath),
      gateUrl: `${scope.origin}/r3/gate`,
      utilityUrl: `${scope.origin}/r3/utility.js`,
      expiresAt: new Date(scope.expiresAt).toISOString(),
    };
  }

  private expire(): void {
    for (const scope of this.contexts.values())
      if (scope.expiresAt <= this.now()) this.contexts.delete(scope.id);
  }

  private get(id: string): PreviewScope {
    const scope = this.contexts.get(id);
    if (!scope || scope.expiresAt <= this.now()) {
      this.contexts.delete(id);
      throw new ArtifactError("Preview context expired or unavailable", 404);
    }
    try {
      this.artifacts.version(scope.artifactId, scope.versionSeq);
    } catch (error) {
      this.contexts.delete(id);
      throw error;
    }
    return scope;
  }

  forRequest(request: Request): PreviewScope {
    const host = request.headers.get("host");
    if (!host || /[\s\\/@?#]/.test(host))
      throw new ArtifactError("Preview context unavailable", 404);
    let origin: URL;
    try {
      origin = new URL(`${this.base.protocol}//${host}`);
    } catch {
      throw new ArtifactError("Preview context unavailable", 404);
    }
    const scope = this.get(origin.hostname.split(".")[0]);
    if (scope.origin !== origin.origin) throw new ArtifactError("Preview context unavailable", 404);
    return scope;
  }

  renew(id: string): ArtifactPreviewContext {
    const scope = Object.freeze({ ...this.get(id), expiresAt: this.now() + CONTEXT_TTL });
    this.contexts.set(id, scope);
    return this.describe(scope);
  }
  revoke(id: string): void {
    this.contexts.delete(id);
  }
  revokeArtifact(id: string): void {
    for (const scope of this.contexts.values())
      if (scope.artifactId === id) this.contexts.delete(scope.id);
  }
  close(): void {
    this.contexts.clear();
  }
}

export function previewPolicy(scope: PreviewScope): Headers {
  return new Headers({
    // URL patterns intentionally exclude every application endpoint and even
    // the capability-check endpoint outside these two namespaces.
    "Connection-Allowlist": `("${scope.origin}/files/*" "${scope.origin}/r3/*"); webrtc=block; redirects=block`,
    "Content-Security-Policy": [
      "default-src 'none'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' blob: data:",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' blob: data:",
      "font-src 'self' blob: data:",
      "media-src 'self' blob: data:",
      "connect-src 'self'",
      "worker-src 'self' blob: data:",
      "frame-src 'self' blob: data:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'none'",
      `frame-ancestors ${scope.applicationOrigin} ${scope.origin}`,
      "sandbox allow-scripts allow-same-origin allow-forms",
      "webrtc 'block'",
    ].join("; "),
    "Permissions-Policy": "camera=(self), microphone=(self)",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-DNS-Prefetch-Control": "off",
  });
}
