import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { CLIENT_AUTH_SCHEMA, ClientAuth } from "./client-auth.ts";
import { observedAddress } from "./client-auth-api.ts";

let db: Database, auth: ClientAuth, now: number;
beforeEach(() => {
  db = new Database(":memory:");
  db.exec(CLIENT_AUTH_SCHEMA);
  now = Date.now();
  auth = new ClientAuth(db, () => now);
});
afterEach(() => db.close());
test("API keys have independent revocation and expiry, with no plaintext in storage or audit", () => {
  const first = auth.createKey("first", now + 1000),
    second = auth.createKey("second");
  expect(auth.authenticate(first.token)?.id).toBe(first.id);
  const revoked: string[] = [];
  auth.onRevoked((id) => revoked.push(id));
  auth.revoke(second.id);
  expect(auth.authenticate(second.token)).toBeNull();
  expect(revoked).toEqual([second.id]);
  now += 1001;
  expect(auth.authenticate(first.token)).toBeNull();
  const persisted = JSON.stringify(db.query("SELECT * FROM client_authorizations").all());
  expect(persisted.includes(first.token)).toBe(false);
  expect(JSON.stringify(auth.auditLog()).includes(first.token)).toBe(false);
});
test("device approval is audited before issuance; polls are bounded and a grant is single-use", () => {
  const request = auth.device("terminal", null);
  expect(() => auth.poll(request.device_code)).toThrow("slow_down");
  now += 10000;
  expect(() => auth.poll(request.device_code)).toThrow("authorization_pending");
  auth.decide(request.user_code, true, null);
  const audit = auth.auditLog() as { event: string; at: number; workerIp: null }[];
  expect(audit[0]).toMatchObject({ event: "approved", at: now, workerIp: null });
  expect(db.query("SELECT * FROM client_access").all()).toHaveLength(0);
  now += 10000;
  const tokens = auth.poll(request.device_code);
  expect(auth.authenticate(tokens.access_token)).not.toBeNull();
  expect(() => auth.poll(request.device_code)).toThrow("invalid_grant");
  expect(() => auth.decide(request.user_code, true, null)).toThrow("unavailable");
});
test("refresh rotates once and reuse revokes the entire client authorization", () => {
  const request = auth.device(null, null);
  auth.decide(request.user_code, true, null);
  now += 5000;
  const original = auth.poll(request.device_code);
  const next = auth.refresh(original.refresh_token);
  const id = auth.authenticate(next.access_token)!.id;
  const revoked: string[] = [];
  auth.onRevoked((value) => revoked.push(value));
  expect(() => auth.refresh(original.refresh_token)).toThrow("invalid_grant");
  expect(auth.authenticate(next.access_token)).toBeNull();
  expect(revoked).toEqual([id]);
  expect(() => auth.refresh(next.refresh_token)).toThrow("invalid_grant");
});
test("denied and expired grants never issue credentials", () => {
  const denied = auth.device(null, null);
  auth.decide(denied.user_code, false, null);
  now += 5000;
  expect(() => auth.poll(denied.device_code)).toThrow("access_denied");
  const expired = auth.device(null, null);
  now += 600001;
  expect(() => auth.poll(expired.device_code)).toThrow("expired_token");
  expect(() => auth.decide(expired.user_code, true, null)).toThrow("unavailable");
  expect(db.query("SELECT * FROM client_access").all()).toHaveLength(0);
});
test("forwarded addresses require an explicitly trusted immediate peer", () => {
  const request = new Request("https://r3.example/api/oauth/device/code", {
    headers: { "x-forwarded-for": "192.0.2.42" },
  });
  const policy = {
    token: randomBytes(32).toString("hex"),
    requireLogin: true,
    version: "fixture",
    allowedHost: () => true,
    peerAddress: () => "127.0.0.1",
  };
  expect(observedAddress(request, policy)).toBe("127.0.0.1");
  expect(observedAddress(request, { ...policy, trustedProxies: new Set(["127.0.0.1"]) })).toBe(
    "192.0.2.42",
  );
  const chain = new Request(request, { headers: { "x-forwarded-for": "192.0.2.42, 192.0.2.43" } });
  expect(observedAddress(chain, { ...policy, trustedProxies: new Set(["127.0.0.1"]) })).toBe(
    "127.0.0.1",
  );
});
