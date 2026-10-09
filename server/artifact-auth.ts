import { timingSafeEqual } from "node:crypto";
import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { BootResponse } from "../shared/types.ts";
import { artifactJson } from "./artifact-http.ts";
import { type AuthService, COOKIE_NAME, cookieOptions } from "./auth.ts";
import type { ClientAuth } from "./client-auth.ts";
import { installClientAuth } from "./client-auth-api.ts";

export interface ArtifactAuthPolicy {
  token: string;
  requireLogin: boolean;
  version: string;
  allowedHost: (hostname: string) => boolean;
  // Explicit application origins cover proxies that rewrite the request Host.
  // Opaque preview documents send Origin:null, which is never an app origin.
  applicationOrigins?: ReadonlySet<string>;
  publicUrl?: string;
  peerAddress?: (request: Request) => string | null;
  trustedProxies?: ReadonlySet<string>;
}

export function artifactRequestHostname(request: Request): string | null {
  const host = request.headers.get("host");
  if (!host) return null;
  if (/[\s\\/@?#]/.test(host)) return null;
  try {
    const parsed = new URL(`http://${host}`);
    return parsed.hostname;
  } catch {
    return null;
  }
}

export function artifactSameOrigin(request: Request, policy: ArtifactAuthPolicy): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    // A CLI has no Fetch Metadata headers. Browser cross-origin requests without
    // Origin do not acquire that local-client exemption.
    const site = request.headers.get("sec-fetch-site");
    return !site || site === "none" || site === "same-origin";
  }
  try {
    if (new URL(origin).origin !== origin) return false;
    if (policy.applicationOrigins?.has(origin)) return true;
    const scheme = new URL(request.url).protocol;
    return origin === new URL(`${scheme}//${request.headers.get("host")}`).origin;
  } catch {
    return false;
  }
}

function equalToken(candidate: string | null, expected: string): boolean {
  if (!candidate) return false;
  const bytes = Buffer.from(candidate);
  const secret = Buffer.from(expected);
  return bytes.length === secret.length && timingSafeEqual(bytes, secret);
}

export function artifactApiPrincipal(
  request: Request,
  policy: ArtifactAuthPolicy,
  clients?: ClientAuth,
): { id: string; expiresAt: number | null } | null {
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  const header = request.headers.get("x-r3-token");
  if (equalToken(header, policy.token) || equalToken(bearer, policy.token))
    return { id: "local", expiresAt: null };
  return clients?.authenticate(header) ?? clients?.authenticate(bearer) ?? null;
}

export function artifactBoot(
  authentication: AuthService,
  policy: ArtifactAuthPolicy,
  cookie: string | undefined,
): BootResponse {
  if (!policy.requireLogin) return { needsAuth: false, token: policy.token };
  return { needsAuth: !authentication.sessionValid(cookie), token: null };
}

// Authenticated fetch streams serve both browser and agent SSE, so events no
// longer need a token-free exception. The local no-login bootstrap still has
// r3's deliberate local-process trust boundary.
export function installArtifactAuth(
  app: Hono,
  authentication: AuthService,
  policy: ArtifactAuthPolicy,
  clients?: ClientAuth,
): void {
  app.use("/api/*", async (c, next) => {
    const host = artifactRequestHostname(c.req.raw);
    if (host === null || !policy.allowedHost(host)) return c.json({ error: "Forbidden host" }, 403);
    if (!artifactSameOrigin(c.req.raw, policy)) return c.json({ error: "Forbidden origin" }, 403);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Cross-Origin-Resource-Policy", "same-origin");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    const publicRead =
      (c.req.method === "GET" || c.req.method === "HEAD") &&
      ["/api/health", "/api/boot"].includes(c.req.path);
    const login = c.req.method === "POST" && c.req.path === "/api/auth/login";
    const oauth =
      clients &&
      c.req.method === "POST" &&
      ["/api/oauth/device/code", "/api/oauth/token"].includes(c.req.path);
    const token = artifactApiPrincipal(c.req.raw, policy, clients);
    if (
      !publicRead &&
      !login &&
      !oauth &&
      !token &&
      !authentication.sessionValid(getCookie(c, COOKIE_NAME))
    )
      return c.json({ error: "Authentication required" }, 401);
    await next();
  });
  app.get("/api/health", (c) =>
    c.json({
      ok: true,
      version: policy.version,
      protocol: "artifacts-v1",
      capabilities: clients ? ["r3-auth-v1"] : [],
    }),
  );
  app.get("/api/boot", (c) => {
    const boot = artifactBoot(authentication, policy, getCookie(c, COOKIE_NAME));
    return c.json(boot, boot.needsAuth ? 401 : 200);
  });
  app.post("/api/auth/login", async (c) => {
    const input = await artifactJson(c.req.raw, 64 * 1024);
    if (typeof input?.token !== "string") return c.json({ error: "Missing login token" }, 400);
    const login = authentication.verifyLogin(input.token);
    if (!login) return c.json({ error: "Invalid login token" }, 401);
    const session = authentication.mintSession(login.tokenId);
    const https =
      c.req.header("x-forwarded-proto") === "https" || new URL(c.req.url).protocol === "https:";
    setCookie(c, COOKIE_NAME, session.cookieValue, cookieOptions(https, session.maxAgeSeconds));
    return c.json({ ok: true });
  });
  app.post("/api/auth/logout", (c) => {
    authentication.destroySession(getCookie(c, COOKIE_NAME));
    deleteCookie(c, COOKIE_NAME, { path: "/" });
    return c.json({ ok: true });
  });
  app.get("/api/auth/tokens", (c) => {
    const current = authentication.sessionTokenId(getCookie(c, COOKIE_NAME));
    return c.json(
      authentication
        .listTokens()
        .map((token) => (token.id === current ? { ...token, current: true } : token)),
    );
  });
  app.post("/api/auth/tokens", async (c) => {
    const input = await artifactJson(c.req.raw, 64 * 1024);
    const label = typeof input?.label === "string" ? input.label.trim() || null : null;
    if (label && label.length > 1000) return c.json({ error: "Label is too long" }, 400);
    return c.json(authentication.createLoginToken(label));
  });
  app.delete("/api/auth/tokens", (c) => c.json({ revoked: authentication.revokeAllTokens() }));
  app.delete("/api/auth/tokens/:id", (c) => {
    const id = c.req.param("id");
    if (id === authentication.sessionTokenId(getCookie(c, COOKIE_NAME)))
      return c.json({ error: "Cannot revoke the token for your current session" }, 409);
    return authentication.revokeToken(id)
      ? c.json({ ok: true })
      : c.json({ error: "Token not found" }, 404);
  });
  if (clients) installClientAuth(app, clients, authentication, policy);
}
