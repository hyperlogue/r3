import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { type ArtifactPreviewContext, artifactMediaKind } from "../shared/artifacts.ts";
import { ArtifactError, requireArtifactPath } from "./artifact-validation.ts";
import type { ArtifactStore } from "./artifacts.ts";

const CONTEXT_TTL = 60 * 60 * 1000;
const MAX_CONTEXTS = 512;
export const PREVIEW_PREFIX = "/__r3_preview/";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
// Opaque-origin fetches omit client hints. The gate and resource requests still
// carry the browser version in User-Agent; no cookie is required or accepted.
const browserIdentity = (request: Request) => digest(request.headers.get("user-agent") ?? "");

interface PreviewState {
  scope: PreviewScope;
  challenges: Map<string, { browser: string; expiresAt: number }>;
  browsers: Set<string>;
}

function localOrigin(url: URL): boolean {
  return (
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "[::1]" ||
    (isIP(url.hostname) === 4 && url.hostname.startsWith("127."))
  );
}
function secureOrigin(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ArtifactError("Invalid preview or application origin");
  }
  const local = localOrigin(url);
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
  readonly presentation: "document" | "media";
  readonly expiresAt: number;
}

export function previewDocumentUrl(
  scope: Pick<PreviewScope, "origin" | "id">,
  path: string,
): string {
  requireArtifactPath(path);
  return `${previewRoot(scope)}/files/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function previewRoot(scope: Pick<PreviewScope, "origin" | "id">): string {
  return `${scope.origin}${PREVIEW_PREFIX}${scope.id}`;
}

// Random path capabilities identify a single immutable publication. Browser
// isolation comes from the opaque sandbox, not URL paths or shared storage.
export class PreviewContexts {
  private readonly contexts = new Map<string, PreviewState>();
  private readonly base: URL | undefined;
  constructor(
    private readonly artifacts: ArtifactStore,
    baseUrl: string | undefined,
    private readonly now: () => number = Date.now,
  ) {
    this.base = baseUrl ? secureOrigin(baseUrl) : undefined;
  }

  create(
    artifactId: string,
    versionSeq: number,
    path: string,
    applicationOrigin: string,
  ): ArtifactPreviewContext {
    const app = secureOrigin(applicationOrigin);
    if (!localOrigin(app) && this.base && this.base.protocol !== "https:")
      throw new ArtifactError(
        "Remote rendered previews require an HTTPS preview origin. Configure R3_PREVIEW_BASE_URL and route that endpoint to the preview listener.",
        503,
      );
    const version = this.artifacts.version(artifactId, versionSeq);
    if (version.kind === "diff")
      throw new ArtifactError("Diff publications have no rendered preview");
    const file = this.artifacts.file(artifactId, versionSeq, requireArtifactPath(path));
    const media = version.kind === "files" && artifactMediaKind(file.mediaType);
    if (!media && !file.renderedHash && file.mediaType.split(";")[0] !== "text/html")
      throw new ArtifactError("This publication has no rendered document at that path");
    this.expire();
    if (this.contexts.size >= MAX_CONTEXTS)
      throw new ArtifactError("Too many open preview contexts", 413);
    const id = `p${randomBytes(24).toString("hex")}`;
    const origin = this.base?.origin ?? app.origin;
    const scope: PreviewScope = Object.freeze({
      id,
      artifactId,
      versionSeq,
      entryPath: path,
      presentation: media ? "media" : "document",
      origin,
      applicationOrigin: app.origin,
      expiresAt: this.now() + CONTEXT_TTL,
    });
    this.contexts.set(id, { scope, challenges: new Map(), browsers: new Set() });
    return this.describe(scope);
  }

  private describe(scope: PreviewScope): ArtifactPreviewContext {
    return {
      id: scope.id,
      artifactId: scope.artifactId,
      versionSeq: scope.versionSeq,
      origin: scope.origin,
      resourceRoot: `${previewRoot(scope)}/files/`,
      documentUrl:
        scope.presentation === "media"
          ? `${previewRoot(scope)}/r3/media`
          : previewDocumentUrl(scope, scope.entryPath),
      gateUrl: `${previewRoot(scope)}/r3/gate`,
      utilityUrl: `${previewRoot(scope)}/r3/utility.js`,
      presentation: scope.presentation,
      expiresAt: new Date(scope.expiresAt).toISOString(),
    };
  }

  private expire(): void {
    for (const { scope } of this.contexts.values())
      if (scope.expiresAt <= this.now()) this.contexts.delete(scope.id);
  }

  private get(id: string): PreviewState {
    const state = this.contexts.get(id);
    if (!state || state.scope.expiresAt <= this.now()) {
      this.contexts.delete(id);
      throw new ArtifactError("Preview context expired or unavailable", 404);
    }
    try {
      this.artifacts.version(state.scope.artifactId, state.scope.versionSeq);
    } catch (error) {
      this.contexts.delete(id);
      throw error;
    }
    return state;
  }

  forRequest(request: Request, applicationOrigins?: ReadonlySet<string>): PreviewScope {
    const host = request.headers.get("host");
    if (!host || /[\s\\/@?#]/.test(host))
      throw new ArtifactError("Preview context unavailable", 404);
    const id = new URL(request.url).pathname.match(/^\/__r3_preview\/(p[0-9a-f]{48})(?:\/|$)/)?.[1];
    if (!id) throw new ArtifactError("Preview context unavailable", 404);
    const { scope } = this.get(id);
    let origin: URL;
    try {
      origin = new URL(`${new URL(scope.origin).protocol}//${host}`);
    } catch {
      throw new ArtifactError("Preview context unavailable", 404);
    }
    if (
      scope.origin !== origin.origin &&
      !(scope.origin === scope.applicationOrigin && applicationOrigins?.has(scope.origin))
    )
      throw new ArtifactError("Preview context unavailable", 404);
    return scope;
  }

  renew(id: string): ArtifactPreviewContext {
    const state = this.get(id);
    state.scope = Object.freeze({ ...state.scope, expiresAt: this.now() + CONTEXT_TTL });
    return this.describe(state.scope);
  }
  revoke(id: string): void {
    this.contexts.delete(id);
  }
  revokeArtifact(id: string): void {
    for (const { scope } of this.contexts.values())
      if (scope.artifactId === id) this.contexts.delete(scope.id);
  }
  close(): void {
    this.contexts.clear();
  }

  // Only the trusted gate is served before verification. Its HTML never has
  // CORS headers, so a foreign opaque document cannot read its challenge. The
  // JSON exchange permits Origin:null only alongside that single-use proof;
  // the serialized opaque origin is not an authentication principal.
  challenge(request: Request): { scope: PreviewScope; challenge: string } {
    const scope = this.forRequest(request);
    const { challenges } = this.get(scope.id);
    for (const [key, value] of challenges)
      if (value.expiresAt <= this.now()) challenges.delete(key);
    while (challenges.size >= 8) challenges.delete(challenges.keys().next().value!);
    const challenge = randomBytes(24).toString("base64url");
    challenges.set(digest(challenge), {
      browser: browserIdentity(request),
      expiresAt: this.now() + 120_000,
    });
    return { scope, challenge };
  }

  verify(request: Request, challenge: string): boolean {
    const scope = this.forRequest(request);
    if (
      request.method !== "POST" ||
      request.headers.get("origin") !== "null" ||
      request.headers.get("content-type")?.split(";")[0] !== "application/json"
    )
      return false;
    const { challenges, browsers } = this.get(scope.id);
    const key = digest(challenge);
    const pending = challenges.get(key);
    if (!pending || pending.expiresAt <= this.now() || pending.browser !== browserIdentity(request))
      return false;
    challenges.delete(key);
    while (browsers.size >= 8) browsers.delete(browsers.keys().next().value!);
    browsers.add(pending.browser);
    return true;
  }

  authorized(request: Request): PreviewScope | null {
    const scope = this.forRequest(request);
    return this.get(scope.id).browsers.has(browserIdentity(request)) ? scope : null;
  }
}

export function previewPolicy(scope: PreviewScope): Headers {
  const root = previewRoot(scope);
  return new Headers({
    // The working /outside/check endpoint is deliberately outside this list.
    "Connection-Allowlist": `("${root}/files/*" "${root}/r3/*"); webrtc=block; redirects=block`,
    "Content-Security-Policy": [
      "default-src 'none'",
      `script-src ${root}/ 'unsafe-inline' 'unsafe-eval' blob: data:`,
      `style-src ${root}/ 'unsafe-inline'`,
      `img-src ${root}/ blob: data:`,
      `font-src ${root}/ blob: data:`,
      `media-src ${root}/ blob: data:`,
      // Let the real allowlist, rather than CSP, enforce the gate's denied probe.
      `connect-src ${scope.origin}`,
      "worker-src 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      `base-uri ${root}/files/`,
      "form-action 'none'",
      `frame-ancestors ${scope.applicationOrigin}`,
      "sandbox allow-scripts",
      "webrtc 'block'",
    ].join("; "),
    "Permissions-Policy": "camera=(), microphone=()",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-DNS-Prefetch-Control": "off",
  });
}
