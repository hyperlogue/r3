import type { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { ArtifactError } from "./artifact-validation.ts";

export const CLIENT_AUTH_SCHEMA = `
CREATE TABLE IF NOT EXISTS client_authorizations (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, label TEXT,
  key_hash TEXT UNIQUE, refresh_hash TEXT UNIQUE, refresh_expires INTEGER,
  created_at INTEGER NOT NULL, expires_at INTEGER, revoked_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS client_access (
  hash TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES client_authorizations(id),
  expires_at INTEGER NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS client_refresh_history (
  hash TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES client_authorizations(id)
) STRICT;
CREATE TABLE IF NOT EXISTS client_devices (
  device_hash TEXT PRIMARY KEY, user_hash TEXT NOT NULL UNIQUE, label TEXT,
  status TEXT NOT NULL, expires_at INTEGER NOT NULL, poll_at INTEGER NOT NULL,
  interval_ms INTEGER NOT NULL, client_id TEXT, request_ip TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS client_audit (
  id INTEGER PRIMARY KEY, client_id TEXT NOT NULL, event TEXT NOT NULL,
  at INTEGER NOT NULL, request_ip TEXT, browser_ip TEXT, worker_ip TEXT
) STRICT;
`;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const secret = () => randomBytes(32).toString("base64url");
const normalizeCode = (code: string) => code.toUpperCase().replace(/[\s-]/g, "");
const ACCESS_SECONDS = 900;
const REFRESH_MS = 90 * 86_400_000;
interface ClientRow {
  id: string;
  kind: string;
  label: string | null;
  revoked_at: number | null;
  expires_at: number | null;
  refresh_expires: number | null;
}
interface DeviceRow {
  status: string;
  client_id: string | null;
  expires_at: number;
  poll_at: number;
  interval_ms: number;
  label: string | null;
  request_ip: string | null;
}

export class OAuthError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

// Single owner, distinct revocable client authorizations. No token or device
// secret is retained in plaintext; audit records contain observations only.
export class ClientAuth {
  private readonly revoked = new Set<(id: string) => void>();
  private readonly requests = new Map<string, { start: number; count: number }>();
  constructor(
    private readonly db: Database,
    private readonly clock = Date.now,
  ) {}

  onRevoked(callback: (id: string) => void): () => void {
    this.revoked.add(callback);
    return () => {
      this.revoked.delete(callback);
    };
  }
  limit(peer: string | null): void {
    const now = this.clock();
    for (const [key, item] of this.requests)
      if (now - item.start >= 60_000) this.requests.delete(key);
    const key = peer ?? "unknown";
    const entry = this.requests.get(key) ?? { start: now, count: 0 };
    if (entry.count >= 60 || (!this.requests.has(key) && this.requests.size >= 2048))
      throw new ArtifactError("Too many authorization requests; try again later", 429);
    entry.count++;
    this.requests.set(key, entry);
  }
  private audit(
    id: string,
    event: string,
    request: string | null = null,
    browser: string | null = null,
    worker: string | null = null,
  ): void {
    this.db
      .query(
        "INSERT INTO client_audit(client_id,event,at,request_ip,browser_ip,worker_ip) VALUES(?,?,?,?,?,?)",
      )
      .run(id, event, this.clock(), request, browser, worker);
  }
  createKey(label: string | null, expiresAt: number | null = null) {
    if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= this.clock()))
      throw new ArtifactError("Key expiry must be a future timestamp");
    const id = randomUUID();
    const token = secret();
    this.db
      .transaction(() => {
        this.db
          .query(
            "INSERT INTO client_authorizations(id,kind,label,key_hash,created_at,expires_at) VALUES(?,?,?,?,?,?)",
          )
          .run(id, "key", label, hash(token), this.clock(), expiresAt);
        this.audit(id, "key-created");
      })
      .immediate();
    return { id, token, expiresAt };
  }
  authenticate(token: string | null): { id: string; expiresAt: number | null } | null {
    if (!token || token.length > 4096) return null;
    const now = this.clock();
    const key = this.db
      .query<ClientRow, [string]>("SELECT * FROM client_authorizations WHERE key_hash = ?")
      .get(hash(token));
    if (key && key.revoked_at === null && (key.expires_at === null || key.expires_at > now))
      return { id: key.id, expiresAt: key.expires_at };
    const access = this.db
      .query<
        { id: string; expiresAt: number },
        [string, number]
      >(`SELECT c.id, a.expires_at AS expiresAt FROM client_access a
      JOIN client_authorizations c ON c.id=a.client_id WHERE a.hash=? AND a.expires_at>? AND c.revoked_at IS NULL`)
      .get(hash(token), now);
    return access ?? null;
  }
  list() {
    return this.db
      .query(
        "SELECT id,kind,label,created_at AS createdAt,expires_at AS expiresAt,revoked_at AS revokedAt FROM client_authorizations ORDER BY created_at DESC",
      )
      .all();
  }
  auditLog() {
    return this.db
      .query(
        "SELECT id,client_id AS clientId,event,at,request_ip AS requestIp,browser_ip AS browserIp,worker_ip AS workerIp FROM client_audit ORDER BY id DESC LIMIT 1000",
      )
      .all();
  }
  observeWorker(id: string, peer: string | null): void {
    if (id !== "local") this.audit(id, "worker-connected", null, null, peer);
  }
  revoke(id: string): boolean {
    const changed = this.db
      .transaction(() => {
        const updated = this.db
          .query("UPDATE client_authorizations SET revoked_at=? WHERE id=? AND revoked_at IS NULL")
          .run(this.clock(), id);
        if (updated.changes) this.audit(id, "revoked");
        return updated.changes > 0;
      })
      .immediate();
    if (changed) for (const callback of this.revoked) callback(id);
    return changed;
  }
  device(label: string | null, peer: string | null) {
    this.limit(peer);
    const now = this.clock();
    this.db.query("DELETE FROM client_devices WHERE expires_at <= ?").run(now);
    if (
      (this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM client_devices").get()?.n ??
        0) >= 256
    )
      throw new ArtifactError("Too many pending authorizations", 429);
    const deviceCode = secret();
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    const userCode = [...randomBytes(10)]
      .map((value) => alphabet[value % alphabet.length])
      .join("");
    this.db
      .query(
        "INSERT INTO client_devices(device_hash,user_hash,label,status,expires_at,poll_at,interval_ms,request_ip) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(hash(deviceCode), hash(userCode), label, "pending", now + 600_000, now, 5000, peer);
    return {
      device_code: deviceCode,
      user_code: `${userCode.slice(0, 5)}-${userCode.slice(5)}`,
      expires_in: 600,
      interval: 5,
    };
  }
  inspect(code: string) {
    const row = this.db
      .query<DeviceRow, [string]>("SELECT * FROM client_devices WHERE user_hash=?")
      .get(hash(normalizeCode(code)));
    if (!row || row.expires_at <= this.clock() || row.status !== "pending")
      throw new ArtifactError("Authorization code is unavailable", 404);
    return { label: row.label, expiresAt: row.expires_at, requestIp: row.request_ip };
  }
  decide(code: string, approved: boolean, peer: string | null): void {
    this.db
      .transaction(() => {
        const current = this.inspect(code);
        const id = approved ? randomUUID() : null;
        if (id) {
          this.db
            .query("INSERT INTO client_authorizations(id,kind,label,created_at) VALUES(?,?,?,?)")
            .run(id, "oauth", current.label, this.clock());
          this.audit(id, "approved", current.requestIp, peer, null);
        }
        this.db
          .query("UPDATE client_devices SET status=?,client_id=? WHERE user_hash=?")
          .run(approved ? "approved" : "denied", id, hash(normalizeCode(code)));
      })
      .immediate();
  }
  private issue(id: string) {
    const access = secret(),
      refresh = secret(),
      now = this.clock();
    this.db
      .query("INSERT INTO client_access(hash,client_id,expires_at) VALUES(?,?,?)")
      .run(hash(access), id, now + ACCESS_SECONDS * 1000);
    this.db
      .query("UPDATE client_authorizations SET refresh_hash=?,refresh_expires=? WHERE id=?")
      .run(hash(refresh), now + REFRESH_MS, id);
    this.db.query("DELETE FROM client_access WHERE expires_at<=?").run(now);
    return {
      access_token: access,
      refresh_token: refresh,
      expires_in: ACCESS_SECONDS,
      token_type: "Bearer" as const,
    };
  }
  poll(code: string) {
    // Commit polling cadence even on authorization_pending/slow_down.
    const outcome = this.db
      .transaction(() => {
        const row = this.db
          .query<DeviceRow, [string]>("SELECT * FROM client_devices WHERE device_hash=?")
          .get(hash(code));
        if (!row) return "invalid_grant";
        const now = this.clock();
        if (row.expires_at <= now) return "expired_token";
        if (row.status === "denied") return "access_denied";
        if (row.status === "consumed") return "invalid_grant";
        if (now < row.poll_at + row.interval_ms) {
          this.db
            .query(
              "UPDATE client_devices SET poll_at=?,interval_ms=interval_ms+5000 WHERE device_hash=?",
            )
            .run(now, hash(code));
          return "slow_down";
        }
        this.db
          .query("UPDATE client_devices SET poll_at=? WHERE device_hash=?")
          .run(now, hash(code));
        if (row.status !== "approved" || !row.client_id) return "authorization_pending";
        const active = this.db
          .query<ClientRow, [string]>("SELECT * FROM client_authorizations WHERE id=?")
          .get(row.client_id);
        if (!active || active.revoked_at !== null) return "access_denied";
        this.db
          .query("UPDATE client_devices SET status='consumed' WHERE device_hash=?")
          .run(hash(code));
        return this.issue(row.client_id);
      })
      .immediate();
    if (typeof outcome === "string") throw new OAuthError(outcome);
    return outcome;
  }
  refresh(token: string) {
    const used = this.db
      .query<{ id: string }, [string]>(
        "SELECT client_id AS id FROM client_refresh_history WHERE hash=?",
      )
      .get(hash(token));
    if (used) {
      this.revoke(used.id);
      throw new OAuthError("invalid_grant");
    }
    return this.db
      .transaction(() => {
        const client = this.db
          .query<ClientRow, [string]>("SELECT * FROM client_authorizations WHERE refresh_hash=?")
          .get(hash(token));
        if (!client || client.revoked_at !== null || (client.refresh_expires ?? 0) <= this.clock())
          throw new OAuthError("invalid_grant");
        this.db
          .query("INSERT INTO client_refresh_history(hash,client_id) VALUES(?,?)")
          .run(hash(token), client.id);
        return this.issue(client.id);
      })
      .immediate();
  }
}
