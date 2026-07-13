// Quick-auth: login tokens -> HttpOnly session cookies (the zellij web-client
// model), used only when the daemon is EXPOSED (config.ts) — reachable beyond
// loopback. This module owns the policy — token generation, hashing, cookie
// name/attributes, session TTL; server/db.ts is pure storage and server/index.ts
// wires it into the request guard + routes.
//
// A login token is a high-entropy secret shown to the user once; only its sha256 is
// stored (db.createAuthToken). A browser trades it for a session cookie (mintSession)
// whose value is likewise stored only hashed. The per-user API token (config.ts
// getToken) is separate — the CLI (and a non-exposed loopback SPA) use it directly.

import { createHash, randomBytes } from "node:crypto";
import type { CookieOptions } from "hono/utils/cookie";
import type { AuthTokenInfo } from "../shared/types.ts";
import * as db from "./db.ts";

// The session cookie name. HttpOnly, so JS never reads it (the SPA authenticates by
// its mere presence, sent automatically on same-origin requests + EventSource).
export const COOKIE_NAME = "r3_session";

// Session lifetime — 30 days, in zellij's ~4-week ballpark. A revoked login token
// kills its sessions immediately (db.revokeAuthToken); this only bounds how long an
// un-revoked one stays logged in.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// sha256 hex of a secret — the at-rest form of both login tokens and cookie values.
// A fast hash is right here: these are 128-256-bit random secrets, not low-entropy
// passwords, so there's nothing to brute-force and no salt/KDF needed.
function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

// Mint a login token: return the plaintext ONCE (the caller shows it and forgets
// it) and persist only its hash.
export function createLoginToken(label: string | null): { token: string; info: AuthTokenInfo } {
  const token = `r3tok_${randomBytes(24).toString("hex")}`;
  const info = db.createAuthToken({ label, tokenHash: hashSecret(token) });
  return { token, info };
}

// Verify a presented login token against the live (non-revoked) set. On success,
// stamp last-used and return the token's id; null otherwise.
export function verifyLogin(token: string): { tokenId: string } | null {
  if (!token) return null;
  const id = db.authTokenForLogin(hashSecret(token));
  if (!id) return null;
  db.touchAuthTokenUsed(id);
  return { tokenId: id };
}

// Create a session row + return the raw cookie value to hand the browser.
export function mintSession(tokenId: string): { cookieValue: string; maxAgeSeconds: number } {
  const cookieValue = randomBytes(32).toString("base64url");
  db.createSession({
    sessionHash: hashSecret(cookieValue),
    tokenId,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS).toISOString(),
  });
  return { cookieValue, maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000) };
}

// Is this cookie value a valid, unexpired session? (A revoked token's sessions are
// already deleted, so an existing row is trustworthy.)
export function sessionValid(cookieValue: string | undefined): boolean {
  return cookieValue != null && db.sessionExists(hashSecret(cookieValue));
}

// Log out: drop the session row so its cookie stops authenticating.
export function destroySession(cookieValue: string | undefined): void {
  if (cookieValue) db.deleteSession(hashSecret(cookieValue));
}

// Cookie attributes. `secure` is set when the browser<->edge leg is HTTPS (e.g.
// `tailscale serve` terminates TLS); the daemon speaks plain HTTP, so the caller
// decides from X-Forwarded-Proto. SameSite=Strict means the cookie never rides a
// cross-site request — closing CSRF/rebinding reads on top of the existing Host
// allowlist + same-origin mutation guard.
export function cookieOptions(secure: boolean, maxAgeSeconds: number): CookieOptions {
  return { httpOnly: true, path: "/", sameSite: "Strict", secure, maxAge: maxAgeSeconds };
}
