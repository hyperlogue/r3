// Login tokens → HttpOnly session cookies (REQUIRE_LOGIN). Tokens are shown once
// and stored hashed; the per-user API token (config.ts getToken) is separate.

import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CookieOptions } from "hono/utils/cookie";
import type { AuthTokenInfo } from "../shared/types.ts";
import { nowIso } from "./ids.ts";

// The session cookie name. HttpOnly, so JS never reads it (the SPA authenticates by
// its mere presence, sent automatically on same-origin requests + EventSource).
export const COOKIE_NAME = "r3_session";

// Session lifetime — 30 days, in zellij's ~4-week ballpark. A revoked login token
// kills its sessions immediately (revokeToken); this only bounds how long an
// un-revoked one stays logged in.
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TEMPORARY_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
// A dot cannot occur in persisted base64url cookies, so temporary cookies never
// fall through to SQLite after expiry, logout, or restart.
const TEMPORARY_SESSION_PREFIX = "r3tmp.";
export const DEFAULT_AUTH_TOKEN_IDLE_DAYS = 14;

type TokenActivity = Pick<AuthTokenInfo, "id" | "createdAt" | "lastUsedAt">;

// sha256 hex of a secret — the at-rest form of both login tokens and cookie values.
// A fast hash is right here: these are 128-256-bit random secrets, not low-entropy
// passwords, so there's nothing to brute-force and no salt/KDF needed.
function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

// Database injection keeps authentication independent of review/artifact bootstrap.
// The schema migration preserves these hash-only tables without changing cookies.
export class AuthService {
  private readonly pendingUses = new Map<string, string>();
  private readonly temporarySessions = new Map<string, number>();

  constructor(
    private readonly db: Database,
    private readonly clock: () => string = nowIso,
    private readonly tokenIdleDays: number = DEFAULT_AUTH_TOKEN_IDLE_DAYS,
  ) {
    if (!Number.isSafeInteger(tokenIdleDays) || tokenIdleDays < 1)
      throw new Error("authTokenIdleDays must be a positive integer");
  }

  createLoginToken(label: string | null): { token: string; info: AuthTokenInfo } {
    const token = `r3tok_${randomBytes(24).toString("hex")}`;
    const id = `authtok_${randomUUID().replaceAll("-", "")}`;
    const createdAt = this.clock();
    this.db
      .query("INSERT INTO auth_tokens(id, label, token_hash, created_at) VALUES (?, ?, ?, ?)")
      .run(id, label, hashSecret(token), createdAt);
    return { token, info: { id, label, createdAt, lastUsedAt: null } };
  }

  // Local sign-in grants live only in this service instance. Store the cookie
  // hash and fixed deadline; there is no reusable login token or database row.
  mintTemporarySession(): { cookieValue: string; maxAgeSeconds: number } {
    this.expireTemporarySessions();
    const cookieValue = `${TEMPORARY_SESSION_PREFIX}${randomBytes(32).toString("base64url")}`;
    this.temporarySessions.set(
      hashSecret(cookieValue),
      Date.parse(this.clock()) + TEMPORARY_SESSION_TTL_MS,
    );
    return { cookieValue, maxAgeSeconds: TEMPORARY_SESSION_TTL_MS / 1000 };
  }

  verifyLogin(token: string): { tokenId: string } | null {
    if (!token) return null;
    const login = this.db.transaction(() => {
      const usedAt = this.clock();
      const row = this.db
        .query<TokenActivity, [string]>(
          "SELECT id, created_at AS createdAt, last_used_at AS lastUsedAt FROM auth_tokens WHERE token_hash = ? AND revoked_at IS NULL",
        )
        .get(hashSecret(token));
      if (!row || !this.tokenActive(row, usedAt)) return null;
      this.db.query("UPDATE auth_tokens SET last_used_at = ? WHERE id = ?").run(usedAt, row.id);
      return { tokenId: row.id };
    })();
    if (login) this.pendingUses.delete(login.tokenId);
    return login;
  }

  mintSession(tokenId: string): { cookieValue: string; maxAgeSeconds: number } {
    const cookieValue = randomBytes(32).toString("base64url");
    this.db.transaction(() => {
      const createdAt = this.clock();
      const token = this.db
        .query<TokenActivity, [string]>(
          "SELECT id, created_at AS createdAt, last_used_at AS lastUsedAt FROM auth_tokens WHERE id = ? AND revoked_at IS NULL",
        )
        .get(tokenId);
      if (!token || !this.tokenActive(token, createdAt)) {
        throw new Error("Cannot create a session for an invalid or revoked login token");
      }
      this.db
        .query(
          "INSERT INTO auth_sessions(id, token_id, session_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          `sess_${randomUUID().replaceAll("-", "")}`,
          tokenId,
          hashSecret(cookieValue),
          createdAt,
          new Date(Date.parse(createdAt) + SESSION_TTL_MS).toISOString(),
        );
      this.db.query("UPDATE auth_tokens SET last_used_at = ? WHERE id = ?").run(createdAt, tokenId);
    })();
    this.pendingUses.delete(tokenId);
    return { cookieValue, maxAgeSeconds: Math.floor(SESSION_TTL_MS / 1000) };
  }

  sessionValid(cookieValue: string | undefined): boolean {
    if (cookieValue?.startsWith(TEMPORARY_SESSION_PREFIX)) {
      const hash = hashSecret(cookieValue);
      const expiresAt = this.temporarySessions.get(hash);
      if (expiresAt !== undefined && expiresAt > Date.parse(this.clock())) return true;
      this.temporarySessions.delete(hash);
      return false;
    }
    return this.sessionTokenId(cookieValue) !== null;
  }

  sessionTokenId(cookieValue: string | undefined): string | null {
    if (!cookieValue || cookieValue.startsWith(TEMPORARY_SESSION_PREFIX)) return null;
    const usedAt = this.clock();
    const row = this.db
      .query<TokenActivity, [string, string]>(`SELECT t.id,
        t.created_at AS createdAt, t.last_used_at AS lastUsedAt FROM auth_sessions s
      JOIN auth_tokens t ON t.id = s.token_id WHERE s.session_hash = ? AND s.expires_at > ? AND t.revoked_at IS NULL`)
      .get(hashSecret(cookieValue), usedAt);
    if (!row || !this.tokenActive(row, usedAt)) return null;
    const previous = this.pendingUses.get(row.id) ?? row.lastUsedAt;
    if (!previous || Date.parse(usedAt) > Date.parse(previous))
      this.pendingUses.set(row.id, usedAt);
    return row.id;
  }

  destroySession(cookieValue: string | undefined): void {
    if (cookieValue?.startsWith(TEMPORARY_SESSION_PREFIX)) {
      this.temporarySessions.delete(hashSecret(cookieValue));
      return;
    }
    if (cookieValue)
      this.db
        .query("DELETE FROM auth_sessions WHERE session_hash = ?")
        .run(hashSecret(cookieValue));
  }

  listTokens(): AuthTokenInfo[] {
    const checkedAt = this.clock();
    return this.db
      .query<AuthTokenInfo, []>(`SELECT id, label, created_at AS createdAt,
      last_used_at AS lastUsedAt FROM auth_tokens WHERE revoked_at IS NULL ORDER BY created_at DESC, rowid DESC`)
      .all()
      .filter((token) => this.tokenActive(token, checkedAt))
      .map((token) => ({
        ...token,
        lastUsedAt: this.pendingUses.get(token.id) ?? token.lastUsedAt,
      }));
  }

  revokeToken(id: string): boolean {
    const revoked = this.db.transaction(() => {
      const result = this.db
        .query("UPDATE auth_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(this.clock(), id);
      if (result.changes) this.db.query("DELETE FROM auth_sessions WHERE token_id = ?").run(id);
      return result.changes > 0;
    })();
    if (revoked) this.pendingUses.delete(id);
    return revoked;
  }

  revokeAllTokens(): number {
    const tokens = this.db
      .query<{ id: string }, []>("SELECT id FROM auth_tokens WHERE revoked_at IS NULL")
      .all();
    const revoked = this.db.transaction(() => {
      const revoke = this.db.query(
        "UPDATE auth_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
      );
      const removeSessions = this.db.query("DELETE FROM auth_sessions WHERE token_id = ?");
      const revokedAt = this.clock();
      let count = 0;
      for (const { id } of tokens) {
        const result = revoke.run(revokedAt, id);
        if (result.changes) removeSessions.run(id);
        count += result.changes;
      }
      return count;
    })();
    for (const { id } of tokens) this.pendingUses.delete(id);
    const temporaryCount = this.temporarySessions.size;
    this.temporarySessions.clear();
    return revoked + temporaryCount;
  }

  expireSessions(): void {
    this.db.query("DELETE FROM auth_sessions WHERE expires_at <= ?").run(this.clock());
  }

  housekeep(): void {
    this.expireTemporarySessions();
    this.flushLastUsed();
  }

  private expireTemporarySessions(): void {
    const now = Date.parse(this.clock());
    for (const [hash, expiresAt] of this.temporarySessions)
      if (expiresAt <= now) this.temporarySessions.delete(hash);
  }

  // Batch the latest cookie use per token. Failed writes keep their pending values.
  flushLastUsed(): void {
    const pending = [...this.pendingUses];
    if (!pending.length) return;
    this.db.transaction(() => {
      const update = this.db.query(`UPDATE auth_tokens SET last_used_at = ?
        WHERE id = ? AND revoked_at IS NULL
        AND (last_used_at IS NULL OR julianday(last_used_at) < julianday(?))`);
      for (const [id, usedAt] of pending) update.run(usedAt, id, usedAt);
    })();
    for (const [id, usedAt] of pending)
      if (this.pendingUses.get(id) === usedAt) this.pendingUses.delete(id);
  }

  private tokenActive(token: TokenActivity, checkedAt: string): boolean {
    const lastUsedAt = this.pendingUses.get(token.id) ?? token.lastUsedAt ?? token.createdAt;
    return Date.parse(checkedAt) - Date.parse(lastUsedAt) < this.tokenIdleDays * 86_400_000;
  }

  cleanupOnStartup(): void {
    this.flushLastUsed();
    const checkedAt = this.clock();
    const inactive = `revoked_at IS NOT NULL OR
      julianday(COALESCE(last_used_at, created_at)) <= julianday(?) - ?`;
    this.db.transaction(() => {
      this.db
        .query(`DELETE FROM auth_sessions WHERE expires_at <= ? OR token_id IN (
          SELECT id FROM auth_tokens WHERE ${inactive}
        )`)
        .run(checkedAt, checkedAt, this.tokenIdleDays);
      this.db.query(`DELETE FROM auth_tokens WHERE ${inactive}`).run(checkedAt, this.tokenIdleDays);
    })();
  }
}

// Cookie attributes. `secure` is set when the browser<->edge leg is HTTPS (e.g.
// `tailscale serve` terminates TLS); the daemon speaks plain HTTP, so the caller
// decides from X-Forwarded-Proto. SameSite=Strict means the cookie never rides a
// cross-site request — closing CSRF/rebinding reads on top of the existing Host
// allowlist + same-origin mutation guard.
export function cookieOptions(secure: boolean, maxAgeSeconds: number): CookieOptions {
  return { httpOnly: true, path: "/", sameSite: "Strict", secure, maxAge: maxAgeSeconds };
}
