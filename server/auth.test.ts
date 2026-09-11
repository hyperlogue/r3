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

  test("expiry is enforced before housekeeping and a fresh service uses the same persisted credentials", () => {
    const issued = auth.createLoginToken(null);
    const session = auth.mintSession(issued.info.id);
    auth = new AuthService(db, () => time);
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
});
