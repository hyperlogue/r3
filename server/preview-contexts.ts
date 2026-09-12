import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { type ArtifactPreviewContext, artifactMediaKind } from "../shared/artifacts.ts";
import { ArtifactError, requireArtifactPath } from "./artifact-validation.ts";
import type { ArtifactStore } from "./artifacts.ts";

const CONTEXT_TTL = 60 * 60 * 1000;
const MAX_CONTEXTS = 512;
export const PREVIEW_COOKIE = "__Host-r3-preview";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const browserIdentity = (request: Request) =>
  digest(
    ["user-agent", "sec-ch-ua", "sec-ch-ua-platform"]
      .map((header) => request.headers.get(header) ?? "")
      .join("\n"),
  );

interface PreviewState {
  scope: PreviewScope;
  challenges: Map<string, { browser: string; expiresAt: number }>;
  browsers: Map<string, { identity: string; userAgent: string }>;
}

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
  readonly presentation: "document" | "media";
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
  private readonly contexts = new Map<string, PreviewState>();
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
    const media = version.kind === "files" && artifactMediaKind(file.mediaType);
    if (!media && !file.renderedHash && file.mediaType.split(";")[0] !== "text/html")
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
      presentation: media ? "media" : "document",
      origin,
      applicationOrigin: app.origin,
      expiresAt: this.now() + CONTEXT_TTL,
    });
    this.contexts.set(id, { scope, challenges: new Map(), browsers: new Map() });
    return this.describe(scope);
  }

  private describe(scope: PreviewScope): ArtifactPreviewContext {
    return {
      id: scope.id,
      artifactId: scope.artifactId,
      versionSeq: scope.versionSeq,
      origin: scope.origin,
      documentUrl:
        scope.presentation === "media"
          ? `${scope.origin}/r3/media`
          : previewDocumentUrl(scope, scope.entryPath),
      gateUrl: `${scope.origin}/r3/gate`,
      utilityUrl: `${scope.origin}/r3/utility.js`,
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
    const { scope } = this.get(origin.hostname.split(".")[0]);
    if (scope.origin !== origin.origin) throw new ArtifactError("Preview context unavailable", 404);
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

  // Only r3's trusted gate document is served before verification. Its script
  // checks real fetch and WebRTC enforcement, then POSTs this single-use proof
  // from the preview origin. A foreign document cannot forge that Origin or
  // read the challenge through CORS. URL sharing alone grants no executable view.
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

  verify(request: Request, challenge: string): string | null {
    const scope = this.forRequest(request);
    if (
      request.method !== "POST" ||
      request.headers.get("origin") !== scope.origin ||
      request.headers.get("content-type")?.split(";")[0] !== "application/json"
    )
      return null;
    const { challenges, browsers } = this.get(scope.id);
    const key = digest(challenge);
    const pending = challenges.get(key);
    if (!pending || pending.expiresAt <= this.now() || pending.browser !== browserIdentity(request))
      return null;
    challenges.delete(key);
    while (browsers.size >= 8) browsers.delete(browsers.keys().next().value!);
    const cookie = randomBytes(32).toString("base64url");
    browsers.set(digest(cookie), {
      identity: pending.browser,
      userAgent: digest(request.headers.get("user-agent") ?? ""),
    });
    return `${PREVIEW_COOKIE}=${cookie}; Path=/; Secure; HttpOnly; SameSite=None; Partitioned`;
  }

  authorized(request: Request): PreviewScope | null {
    const scope = this.forRequest(request);
    const cookie = request.headers
      .get("cookie")
      ?.split(";")
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${PREVIEW_COOKIE}=`))
      ?.slice(PREVIEW_COOKIE.length + 1);
    const browser = cookie ? this.get(scope.id).browsers.get(digest(cookie)) : undefined;
    if (!browser) return null;
    if (browser.identity === browserIdentity(request)) return scope;
    // Chromium omits client hints on worker script requests and worker fetches.
    // They may use the verified cookie with the same User-Agent. Navigations
    // still require the full browser identity used by the verification gate.
    const workerResource = ["worker", "sharedworker", "script", "empty"].includes(
      request.headers.get("sec-fetch-dest") ?? "",
    );
    return workerResource &&
      !request.headers.has("sec-ch-ua") &&
      !request.headers.has("sec-ch-ua-platform") &&
      browser.userAgent === digest(request.headers.get("user-agent") ?? "")
      ? scope
      : null;
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
