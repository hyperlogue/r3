import { isIP } from "node:net";
import type { Hono } from "hono";
import { getCookie } from "hono/cookie";
import type { ArtifactAuthPolicy } from "./artifact-auth.ts";
import { artifactJson } from "./artifact-http.ts";
import { ArtifactError, optionalText, requireString } from "./artifact-validation.ts";
import { type AuthService, COOKIE_NAME } from "./auth.ts";
import { type ClientAuth, OAuthError } from "./client-auth.ts";

export function observedAddress(request: Request, policy: ArtifactAuthPolicy): string | null {
  const peer = policy.peerAddress?.(request) ?? null;
  if (peer && policy.trustedProxies?.has(peer)) {
    // A trusted edge must overwrite this header. Do not guess through a chain.
    const address = request.headers.get("x-forwarded-for")?.trim();
    if (address && isIP(address)) return address;
  }
  return peer && isIP(peer) ? peer : null;
}

async function form(request: Request): Promise<URLSearchParams> {
  if (
    !/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(
      request.headers.get("content-type") ?? "",
    )
  )
    throw new ArtifactError("OAuth requests require form encoding");
  const reader = request.body?.getReader();
  if (!reader) throw new ArtifactError("Missing request body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 8192) {
        void reader.cancel();
        throw new ArtifactError("Request body is too large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const value = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
  for (const key of value.keys())
    if (value.getAll(key).length !== 1) throw new ArtifactError("Duplicate OAuth parameter");
  if (value.get("client_id") !== "r3-cli") throw new ArtifactError("Unknown OAuth client");
  return value;
}

export function installClientAuth(
  app: Hono,
  clients: ClientAuth,
  browser: AuthService,
  policy: ArtifactAuthPolicy,
): void {
  app.post("/api/oauth/device/code", async (c) => {
    const body = await form(c.req.raw);
    const result = clients.device(
      optionalText(body.get("label"), "label", 1000),
      observedAddress(c.req.raw, policy),
    );
    const base = policy.publicUrl ?? new URL(c.req.url).origin;
    const verification = `${base}/authorize`;
    return c.json({
      ...result,
      verification_uri: verification,
      verification_uri_complete: `${verification}?code=${encodeURIComponent(result.user_code)}`,
    });
  });
  app.post("/api/oauth/token", async (c) => {
    clients.limit(observedAddress(c.req.raw, policy));
    const body = await form(c.req.raw);
    try {
      if (body.get("grant_type") === "urn:ietf:params:oauth:grant-type:device_code")
        return c.json(clients.poll(requireString(body.get("device_code"), "device_code", 4096)));
      if (body.get("grant_type") === "refresh_token")
        return c.json(
          clients.refresh(requireString(body.get("refresh_token"), "refresh_token", 4096)),
        );
      return c.json({ error: "unsupported_grant_type" }, 400);
    } catch (error) {
      if (error instanceof OAuthError) return c.json({ error: error.code }, 400);
      throw error;
    }
  });
  app.use("/api/oauth/device/*", async (c, next) => {
    // Approval belongs to the authenticated browser. Client credentials cannot
    // approve further devices on an exposed backend.
    if (policy.requireLogin && !browser.sessionValid(getCookie(c, COOKIE_NAME)))
      return c.json({ error: "Approve access in an authenticated r3 browser" }, 401);
    clients.limit(observedAddress(c.req.raw, policy));
    await next();
  });
  app.post("/api/oauth/device/inspect", async (c) => {
    const body = await artifactJson(c.req.raw, 8192);
    return c.json(clients.inspect(requireString(body.userCode, "userCode", 100)));
  });
  app.post("/api/oauth/device/decision", async (c) => {
    const body = await artifactJson(c.req.raw, 8192);
    if (typeof body.approved !== "boolean")
      throw new ArtifactError("An explicit approval decision is required");
    clients.decide(
      requireString(body.userCode, "userCode", 100),
      body.approved,
      observedAddress(c.req.raw, policy),
    );
    return c.json({ ok: true });
  });
  app.get("/api/auth/clients", (c) => c.json(clients.list()));
  app.get("/api/auth/audit", (c) => c.json(clients.auditLog()));
  app.post("/api/auth/clients", async (c) => {
    const body = await artifactJson(c.req.raw, 8192);
    if (body.expiresAt !== undefined && typeof body.expiresAt !== "number")
      throw new ArtifactError("Invalid key expiry");
    return c.json(
      clients.createKey(
        optionalText(body.label, "label", 1000),
        body.expiresAt as number | undefined,
      ),
      201,
    );
  });
  app.delete("/api/auth/clients/:id", (c) =>
    clients.revoke(c.req.param("id"))
      ? c.json({ ok: true })
      : c.json({ error: "Client not found" }, 404),
  );
}
