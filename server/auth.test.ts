import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createArtifactTables } from "./artifact-schema.ts";
import { AuthService, cookieOptions } from "./auth.ts";

let db: Database;
let auth: AuthService;
let time: string;
beforeEach(() => {
  db = new Database(":memory:");
  createArtifactTables(db);
  time = "2026-09-01T00:00:00.000Z";
  auth = new AuthService(db, () => time);
});
afterEach(() => db.close());

describe("injected authentication store", () => {
  test("browsing coalesces cookie uses across sessions without writing until housekeeping", () => {
    const issued = auth.createLoginToken(null);
    const first = auth.mintSession(issued.info.id);
    const second = auth.mintSession(issued.info.id);
    const changes = () =>
      db.query<{ count: number }, []>("SELECT total_changes() AS count").get()!.count;
    const before = changes();
    const startedAt = Date.parse(time);
    for (let i = 1; i <= 100; i++) {
      time = new Date(startedAt + i * 300).toISOString();
      expect(auth.sessionValid(i % 2 ? first.cookieValue : second.cookieValue)).toBe(true);
      expect(auth.listTokens()[0].lastUsedAt).toBe(time);
    }
    expect(changes()).toBe(before);
    expect(db.query("SELECT last_used_at FROM auth_tokens").get()).toEqual({
      last_used_at: issued.info.createdAt,
    });
    auth.flushLastUsed();
    expect(changes()).toBe(before + 1);
    expect(db.query("SELECT last_used_at FROM auth_tokens").get()).toEqual({ last_used_at: time });
    auth.flushLastUsed();
    expect(changes()).toBe(before + 1);
  });

  test("pending cookie use keeps a token active past its persisted inactivity boundary", () => {
    const issued = auth.createLoginToken(null);
    const session = auth.mintSession(issued.info.id);
    time = "2026-09-14T23:59:59.999Z";
    expect(auth.sessionValid(session.cookieValue)).toBe(true);
    time = "2026-09-15T00:00:00.000Z";
    expect(auth.sessionValid(session.cookieValue)).toBe(true);
    expect(auth.listTokens()).toEqual([{ ...issued.info, lastUsedAt: time }]);
    expect(db.query("SELECT last_used_at FROM auth_tokens").get()).toEqual({
      last_used_at: issued.info.createdAt,
    });
    auth.flushLastUsed();
    expect(db.query("SELECT last_used_at FROM auth_tokens").get()).toEqual({ last_used_at: time });
    time = "2026-09-29T00:00:00.000Z";
    expect(auth.sessionValid(session.cookieValue)).toBe(false);
    expect(auth.listTokens()).toEqual([]);
  });

  test("a failed batch retains every pending use for authorization and a later retry", () => {
    const first = auth.createLoginToken("First");
    const firstSession = auth.mintSession(first.info.id);
    const second = auth.createLoginToken("Fails");
    const secondSession = auth.mintSession(second.info.id);
    time = "2026-09-14T23:59:59.999Z";
    expect(auth.sessionValid(firstSession.cookieValue)).toBe(true);
    expect(auth.sessionValid(secondSession.cookieValue)).toBe(true);
    db.exec(`CREATE TRIGGER fail_auth_use BEFORE UPDATE OF last_used_at ON auth_tokens
      WHEN OLD.label = 'Fails' BEGIN SELECT RAISE(ABORT, 'Deferred write failed'); END`);
    expect(() => auth.flushLastUsed()).toThrow("Deferred write failed");
    expect(db.query("SELECT last_used_at FROM auth_tokens").all()).toEqual([
      { last_used_at: first.info.createdAt },
      { last_used_at: second.info.createdAt },
    ]);
    expect(auth.listTokens().map((token) => token.lastUsedAt)).toEqual([time, time]);
    time = "2026-09-15T00:00:00.000Z";
    expect(auth.sessionValid(firstSession.cookieValue)).toBe(true);
    expect(auth.sessionValid(secondSession.cookieValue)).toBe(true);
    db.exec("DROP TRIGGER fail_auth_use");
    auth.flushLastUsed();
    expect(db.query("SELECT last_used_at FROM auth_tokens").all()).toEqual([
      { last_used_at: time },
      { last_used_at: time },
    ]);
  });

  test.each(["single", "all"])(
    "%s revocation discards deferred use without restoring access",
    (mode) => {
      const issued = auth.createLoginToken(null);
      const session = auth.mintSession(issued.info.id);
      time = "2026-09-01T00:00:30.000Z";
      expect(auth.sessionValid(session.cookieValue)).toBe(true);
      if (mode === "single") expect(auth.revokeToken(issued.info.id)).toBe(true);
      else expect(auth.revokeAllTokens()).toBe(1);
      auth.flushLastUsed();
      expect(auth.sessionValid(session.cookieValue)).toBe(false);
      expect(auth.verifyLogin(issued.token)).toBeNull();
      expect(db.query("SELECT last_used_at, revoked_at FROM auth_tokens").get()).toEqual({
        last_used_at: issued.info.createdAt,
        revoked_at: time,
      });
    },
  );

  test("login and session values are generated once and only their digests are persisted", () => {
    const issued = auth.createLoginToken("Test access");
    expect(auth.verifyLogin(issued.token)?.tokenId).toBe(issued.info.id);
    const session = auth.mintSession(issued.info.id);
    expect(auth.sessionValid(session.cookieValue)).toBe(true);
    expect(auth.sessionTokenId(session.cookieValue)).toBe(issued.info.id);
    expect(auth.listTokens()).toEqual([{ ...issued.info, lastUsedAt: time }]);
    const stored =
      JSON.stringify(db.query("SELECT * FROM auth_tokens").all()) +
      JSON.stringify(db.query("SELECT * FROM auth_sessions").all());
    expect(stored.includes(issued.token)).toBe(false);
    expect(stored.includes(session.cookieValue)).toBe(false);
    expect(auth.sessionValid(undefined)).toBe(false);
    auth.destroySession(session.cookieValue);
    expect(auth.sessionValid(session.cookieValue)).toBe(false);
  });

  test("revocation removes sessions atomically and prevents subsequent session minting", () => {
    const issued = auth.createLoginToken(null);
    const session = auth.mintSession(issued.info.id);
    expect(auth.revokeToken(issued.info.id)).toBe(true);
    expect(auth.revokeToken(issued.info.id)).toBe(false);
    expect(auth.verifyLogin(issued.token)).toBeNull();
    expect(auth.sessionValid(session.cookieValue)).toBe(false);
    expect(() => auth.mintSession(issued.info.id)).toThrow("invalid or revoked");
    expect(auth.listTokens()).toEqual([]);
    expect(db.query("SELECT * FROM auth_sessions").all()).toEqual([]);
  });

  test("revoke-all includes inactive rows so a larger window cannot restore manually revoked access", () => {
    const issued = auth.createLoginToken(null);
    time = "2026-09-15T00:00:00.000Z";
    expect(auth.listTokens()).toEqual([]);
    expect(auth.revokeAllTokens()).toBe(1);
    auth = new AuthService(db, () => time, 45);
    expect(auth.verifyLogin(issued.token)).toBeNull();
    expect(auth.listTokens()).toEqual([]);
  });

  test("expiry is enforced before housekeeping and a fresh service uses the same persisted credentials", () => {
    auth = new AuthService(db, () => time, 45);
    const issued = auth.createLoginToken(null);
    const session = auth.mintSession(issued.info.id);
    auth = new AuthService(db, () => time, 45);
    expect(auth.sessionValid(session.cookieValue)).toBe(true);
    time = "2026-10-01T00:00:00.000Z";
    expect(auth.sessionValid(session.cookieValue)).toBe(false);
    auth.expireSessions();
    expect(db.query("SELECT * FROM auth_sessions").all()).toEqual([]);
    auth.createLoginToken("Second access");
    expect(auth.revokeAllTokens()).toBe(2);
    expect(auth.revokeAllTokens()).toBe(0);
    expect(cookieOptions(true, 10)).toEqual({
      httpOnly: true,
      path: "/",
      sameSite: "Strict",
      secure: true,
      maxAge: 10,
    });
  });

  test("never-used tokens expire at the idle boundary without mutating their rows until startup", () => {
    const issued = auth.createLoginToken(null);
    const before = db.query<{ count: number }, []>("SELECT total_changes() AS count").get()!.count;
    time = "2026-09-14T23:59:59.999Z";
    expect(auth.listTokens()).toEqual([issued.info]);
    time = "2026-09-15T00:00:00.000Z";
    expect(auth.listTokens()).toEqual([]);
    expect(auth.verifyLogin(issued.token)).toBeNull();
    expect(db.query("SELECT last_used_at, revoked_at FROM auth_tokens").get()).toEqual({
      last_used_at: null,
      revoked_at: null,
    });
    expect(db.query("SELECT total_changes() AS count").get()).toEqual({ count: before });
    auth.cleanupOnStartup();
    expect(db.query("SELECT * FROM auth_tokens").all()).toEqual([]);
  });

  test("successful logins extend inactivity while overdue login attempts cannot revive tokens", () => {
    const issued = auth.createLoginToken(null);
    time = "2026-09-14T00:00:00.000Z";
    expect(auth.verifyLogin(issued.token)).toEqual({ tokenId: issued.info.id });
    expect(auth.listTokens()[0].lastUsedAt).toBe(time);
    time = "2026-09-27T23:59:59.999Z";
    expect(auth.listTokens()).toHaveLength(1);
    time = "2026-09-28T00:00:00.000Z";
    expect(auth.verifyLogin(issued.token)).toBeNull();
    expect(db.query("SELECT last_used_at, revoked_at FROM auth_tokens").get()).toEqual({
      last_used_at: "2026-09-14T00:00:00.000Z",
      revoked_at: null,
    });
  });

  test("every valid session refreshes its token without refreshing unrelated or expired sessions", () => {
    const issued = auth.createLoginToken(null);
    const first = auth.mintSession(issued.info.id);
    const second = auth.mintSession(issued.info.id);
    const unrelated = auth.createLoginToken("Unused");
    time = "2026-09-14T00:00:00.000Z";
    expect(auth.sessionValid(first.cookieValue)).toBe(true);
    time = "2026-09-27T00:00:00.000Z";
    expect(auth.sessionTokenId(second.cookieValue)).toBe(issued.info.id);
    expect(auth.listTokens()).toEqual([{ ...issued.info, lastUsedAt: time }]);
    expect(auth.verifyLogin(unrelated.token)).toBeNull();
    time = "2026-10-01T00:00:00.000Z";
    expect(auth.sessionValid(first.cookieValue)).toBe(false);
    expect(auth.listTokens()[0].lastUsedAt).toBe("2026-09-27T00:00:00.000Z");
  });

  test("idle cookies are denied before housekeeping without deleting data until startup", () => {
    const issued = auth.createLoginToken(null);
    const session = auth.mintSession(issued.info.id);
    time = "2026-09-15T00:00:00.000Z";
    expect(auth.sessionValid(session.cookieValue)).toBe(false);
    expect(() => auth.mintSession(issued.info.id)).toThrow("invalid or revoked");
    expect(auth.listTokens()).toEqual([]);
    expect(db.query("SELECT revoked_at FROM auth_tokens").get()).toEqual({ revoked_at: null });
    expect(db.query("SELECT id FROM auth_sessions").all()).toHaveLength(1);
    auth.cleanupOnStartup();
    expect(db.query("SELECT * FROM auth_tokens").all()).toEqual([]);
    expect(db.query("SELECT * FROM auth_sessions").all()).toEqual([]);
  });

  test("custom inactivity settings apply to login, session minting and startup cleanup", () => {
    auth = new AuthService(db, () => time, 2);
    const expired = auth.createLoginToken(null);
    time = "2026-09-02T00:00:00.000Z";
    const recent = auth.createLoginToken(null);
    time = "2026-09-03T00:00:00.000Z";
    expect(() => auth.mintSession(expired.info.id)).toThrow("invalid or revoked");
    expect(auth.verifyLogin(expired.token)).toBeNull();
    auth.cleanupOnStartup();
    expect(auth.verifyLogin(recent.token)).toEqual({ tokenId: recent.info.id });
    expect(auth.listTokens()).toEqual([{ ...recent.info, lastUsedAt: time }]);
    expect(db.query("SELECT id FROM auth_tokens").all()).toEqual([{ id: recent.info.id }]);
  });
});
