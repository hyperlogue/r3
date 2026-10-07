import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import {
  type ArtifactPreviewContext,
  type ArtifactPreviewNetwork,
  artifactMediaKind,
} from "../shared/artifacts.ts";
import { ArtifactError, requireArtifactPath } from "./artifact-validation.ts";
import type { ArtifactStore } from "./artifacts.ts";

const CONTEXT_TTL = 60 * 60 * 1000;
const MAX_CONTEXTS = 512;
const resumeKey = (id: string) => `r${createHash("sha256").update(id).digest("hex").slice(0, 32)}`;
export const PREVIEW_PREFIX = "/__r3_preview/";

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
  readonly network: ArtifactPreviewNetwork;
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
  private readonly contexts = new Map<string, PreviewScope>();
  private readonly alternatives = new Map<string, string>();
  private readonly resumable = new Map<string, string>();
  constructor(
    private readonly artifacts: ArtifactStore,
    private readonly now: () => number = Date.now,
  ) {}

  create(
    artifactId: string,
    versionSeq: number,
    path: string,
    applicationOrigin: string,
    network: unknown = "blocked",
  ): ArtifactPreviewContext {
    const app = secureOrigin(applicationOrigin);
    const version = this.artifacts.version(artifactId, versionSeq);
    if (network !== "blocked" && network !== "compatible" && network !== "external")
      throw new ArtifactError("Preview network must be blocked, compatible, or external");
    if (network === "external" && version.kind !== "html")
      throw new ArtifactError("Only HTML artifacts can allow external connections");
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
    const origin = app.origin;
    const scope: PreviewScope = Object.freeze({
      id,
      artifactId,
      versionSeq,
      entryPath: path,
      presentation: media ? "media" : "document",
      network,
      origin,
      applicationOrigin: app.origin,
      expiresAt: this.now() + CONTEXT_TTL,
    });
    this.contexts.set(id, scope);
    this.resumable.set(resumeKey(id), id);
    return this.describe(scope);
  }

  // Call only after application authentication. A hint cannot name a resource
  // capability and cannot renew a different publication, origin, path or policy.
  resume(keys: string[], artifactId: string, seq: number, path: string, applicationOrigin: string) {
    this.expire();
    const result: ArtifactPreviewContext[] = [];
    for (const key of keys) {
      const id = this.resumable.get(key);
      const scope = id ? this.contexts.get(id) : undefined;
      if (
        scope &&
        scope.artifactId === artifactId &&
        scope.versionSeq === seq &&
        scope.entryPath === path &&
        scope.applicationOrigin === applicationOrigin &&
        scope.presentation === "document" &&
        scope.network !== "external"
      )
        result.push(this.renew(scope.id));
    }
    return result;
  }

  // The HTML request cannot read localStorage consent. Prepare both restrictive
  // modes; the first preview request retires the unused alternative. External
  // access is never prepared by navigation. Existing expiry/capacity bounds apply.
  prepare(artifactId: string, seq: number, path: string, applicationOrigin: string) {
    const blocked = this.create(artifactId, seq, path, applicationOrigin, "blocked");
    try {
      const compatible = this.create(artifactId, seq, path, applicationOrigin, "compatible");
      this.alternatives.set(blocked.id, compatible.id);
      this.alternatives.set(compatible.id, blocked.id);
      return { applicationOrigin, blocked, compatible };
    } catch (error) {
      this.revoke(blocked.id);
      throw error;
    }
  }

  private describe(scope: PreviewScope): ArtifactPreviewContext {
    return {
      id: scope.id,
      resumeKey: resumeKey(scope.id),
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
      network: scope.network,
      expiresAt: new Date(scope.expiresAt).toISOString(),
    };
  }

  private expire(): void {
    for (const scope of this.contexts.values())
      if (scope.expiresAt <= this.now()) this.revoke(scope.id);
  }

  private get(id: string): PreviewScope {
    const scope = this.contexts.get(id);
    if (!scope || scope.expiresAt <= this.now()) {
      this.revoke(id);
      throw new ArtifactError("Preview context expired or unavailable", 404);
    }
    try {
      this.artifacts.version(scope.artifactId, scope.versionSeq);
    } catch (error) {
      this.revoke(id);
      throw error;
    }
    return scope;
  }

  forRequest(request: Request, applicationOrigins?: ReadonlySet<string>): PreviewScope {
    const host = request.headers.get("host");
    if (!host || /[\s\\/@?#]/.test(host))
      throw new ArtifactError("Preview context unavailable", 404);
    const id = new URL(request.url).pathname.match(/^\/__r3_preview\/(p[0-9a-f]{48})(?:\/|$)/)?.[1];
    if (!id) throw new ArtifactError("Preview context unavailable", 404);
    const scope = this.get(id);
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
    const alternative = this.alternatives.get(scope.id);
    if (alternative) this.revoke(alternative);
    return scope;
  }

  renew(id: string): ArtifactPreviewContext {
    const scope = Object.freeze({ ...this.get(id), expiresAt: this.now() + CONTEXT_TTL });
    this.contexts.set(id, scope);
    return this.describe(scope);
  }
  revoke(id: string): void {
    this.resumable.delete(resumeKey(id));
    const alternative = this.alternatives.get(id);
    if (alternative) this.alternatives.delete(alternative);
    this.alternatives.delete(id);
    this.contexts.delete(id);
  }
  revokeArtifact(id: string): void {
    for (const scope of this.contexts.values()) if (scope.artifactId === id) this.revoke(scope.id);
  }
  close(): void {
    this.contexts.clear();
    this.alternatives.clear();
    this.resumable.clear();
  }
}

export function previewPolicy(scope: PreviewScope): Headers {
  const root = previewRoot(scope);
  const external = scope.network === "external";
  const resources = external ? `${root}/ http: https:` : `${root}/`;
  const headers = new Headers({
    "Content-Security-Policy": [
      "default-src 'none'",
      `script-src ${resources} 'unsafe-inline' 'unsafe-eval' blob: data:`,
      `style-src ${resources} 'unsafe-inline'`,
      `img-src ${resources} blob: data:`,
      `font-src ${resources} blob: data:`,
      `media-src ${resources} blob: data:`,
      // Let the real allowlist, rather than CSP, enforce the gate's denied probe.
      `connect-src ${scope.origin}${external ? " http: https: ws: wss:" : ""}`,
      "worker-src 'none'",
      "frame-src 'none'",
      "object-src 'none'",
      `base-uri ${root}/files/`,
      "form-action 'none'",
      `frame-ancestors ${scope.applicationOrigin}`,
      "sandbox allow-scripts",
      ...(external ? [] : ["webrtc 'block'"]),
    ].join("; "),
    "Permissions-Policy": "camera=(), microphone=(), display-capture=()",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "X-DNS-Prefetch-Control": "off",
  });
  // Never grant an exception by changing an existing context. A new, explicitly
  // requested HTML context owns its policy for its entire lifetime.
  if (!external)
    headers.set(
      "Connection-Allowlist",
      `("${root}/files/*" "${root}/r3/*"); webrtc=block; redirects=block`,
    );
  return headers;
}
