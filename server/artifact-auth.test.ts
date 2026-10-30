import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { type ArtifactAuthPolicy, installArtifactAuth } from "./artifact-auth.ts";
import { createArtifactTables } from "./artifact-schema.ts";
import { AuthService } from "./auth.ts";
import { LocalBrowserAccess } from "./local-access.ts";

let db: Database;
let authentication: AuthService;
let app: Hono;
let policy: ArtifactAuthPolicy;
let time: string;
beforeEach(() => {
  db = new Database(":memory:");
  createArtifactTables(db);
  time = "2026-09-01T00:00:00.000Z";
  authentication = new AuthService(db, () => time);
  policy = {
    token: randomBytes(32).toString("base64url"),
    requireLogin: true,
    localAccess: new LocalBrowserAccess(() => Date.parse(time)),
    version: "test",
    allowedHost: (host) => host === "localhost",
    applicationOrigins: new Set(["https://app.example"]),
  };
  app = new Hono();
  installArtifactAuth(app, authentication, policy);
  app.get("/api/private", (c) => c.json({ private: true }));
  app.get("/api/events", (c) => c.text("Event stream"));
  app.post("/api/private", (c) => c.json({ changed: true }));
});
afterEach(() => db.close());
function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("host")) headers.set("host", "localhost:8791");
  return app.request(new Request(`http://localhost:8791${path}`, { ...init, headers }));
}

describe("artifact application auth boundary", () => {
  test.each([false, true])(
    "local tickets obey login policy and repeated opens reuse sessions with requireLogin=%s",
    async (requireLogin) => {
      policy.requireLogin = requireLogin;
      let cookie = "";
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await request("/api/auth/local", {
          method: "POST",
          headers: { "content-type": "application/json", cookie, "x-forwarded-proto": "https" },
          body: JSON.stringify({ ticket: policy.localAccess!.issue() }),
        });
        expect(response.status).toBe(200);
        if (requireLogin && attempt === 0) {
          const value = response.headers.get("set-cookie")!;
          expect(value).toContain("HttpOnly");
          expect(value).toContain("SameSite=Strict");
          expect(value).toContain("Secure");
          expect(value).toContain("Max-Age=2592000");
          cookie = value.split(";", 1)[0]!;
        } else expect(response.headers.get("set-cookie")).toBeNull();
        expect((await request("/api/boot", { headers: { cookie } })).status).toBe(200);
        time = "2026-09-01T23:00:00.000Z";
      }
      expect(authentication.listTokens()).toHaveLength(requireLogin ? 1 : 0);
      expect(db.query("SELECT COUNT(*) AS n FROM auth_tokens").get()).toEqual({
        n: requireLogin ? 1 : 0,
      });
      expect(db.query("SELECT COUNT(*) AS n FROM auth_sessions").get()).toEqual({
        n: requireLogin ? 1 : 0,
      });
      time = "2026-09-02T00:00:00.000Z";
      expect((await request("/api/boot", { headers: { cookie } })).status).toBe(200);
      time = "2026-09-16T00:00:00.000Z";
      expect((await request("/api/boot", { headers: { cookie } })).status).toBe(
        requireLogin ? 401 : 200,
      );
      expect((await request("/api/events", { headers: { cookie } })).status).toBe(
        requireLogin ? 401 : 200,
      );
      // Expired browser access does not prevent a fresh ticket from signing in.
      const reopened = await request("/api/auth/local", {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ ticket: policy.localAccess!.issue() }),
      });
      expect(reopened.status).toBe(200);
      expect(Boolean(reopened.headers.get("set-cookie"))).toBe(requireLogin);
      expect(authentication.listTokens()).toHaveLength(requireLogin ? 1 : 0);
    },
  );

  test("local tickets preserve a reusable browser login and enforce one-use expiry and origin guards", async () => {
    const regular = authentication.createLoginToken("Browser");
    const session = authentication.mintSession(regular.info.id);
    const cookie = `r3_session=${session.cookieValue}`;
    const ticket = policy.localAccess!.issue();
    const exchange = (value: string, origin = "http://localhost:8791") =>
      request("/api/auth/local", {
        method: "POST",
        headers: { cookie, origin, "content-type": "application/json" },
        body: JSON.stringify({ ticket: value }),
      });
    expect((await exchange(ticket, "null")).status).toBe(403);
    expect((await exchange(ticket, "http://localhost:8792")).status).toBe(403);
    const accepted = await exchange(ticket);
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("set-cookie")).toBeNull();
    expect((await exchange(ticket)).status).toBe(401);
    const expired = policy.localAccess!.issue();
    time = "2026-09-01T00:05:00.000Z";
    expect((await exchange(expired)).status).toBe(401);
    expect(db.query("SELECT COUNT(*) AS n FROM auth_tokens").get()).toEqual({ n: 1 });
    expect(db.query("SELECT COUNT(*) AS n FROM auth_sessions").get()).toEqual({ n: 1 });
    expect(authentication.sessionTokenId(session.cookieValue)).toBe(regular.info.id);
  });

  test("cookie requests refresh last use only after origin checks and expired cookies cannot log in", async () => {
    policy.requireLogin = true;
    const issued = authentication.createLoginToken("Browser");
    const response = await request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: issued.token }),
    });
    const headers = { cookie: response.headers.get("set-cookie")!.split(";", 1)[0] };
    time = "2026-09-14T00:00:00.000Z";
    expect(
      (await request("/api/private", { headers: { ...headers, origin: "null" } })).status,
    ).toBe(403);
    expect(authentication.listTokens()[0].lastUsedAt).toBe("2026-09-01T00:00:00.000Z");
    expect((await request("/api/private", { headers })).status).toBe(200);
    expect((await request("/api/auth/tokens", { headers })).status).toBe(200);
    expect(authentication.listTokens()[0].lastUsedAt).toBe(time);
    time = "2026-09-28T00:00:00.000Z";
    expect((await request("/api/private", { headers })).status).toBe(401);
    expect((await request("/api/events", { headers })).status).toBe(401);
    expect((await request("/api/boot", { headers })).status).toBe(401);
    expect(
      (
        await request("/api/auth/login", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token: issued.token }),
        })
      ).status,
    ).toBe(401);
    expect(
      await (await request("/api/auth/tokens", { headers: { "x-r3-token": policy.token } })).json(),
    ).toEqual([]);
  });

  test("required login keeps the API credential private and protects every data stream", async () => {
    expect(await (await request("/api/boot")).json()).toEqual({
      needsAuth: true,
      token: null,
      loginRequired: true,
    });
    expect((await request("/api/health")).status).toBe(200);
    expect((await request("/api/private")).status).toBe(401);
    expect((await request("/api/events")).status).toBe(401);
    expect(
      (await request("/api/private", { headers: { "x-r3-token": policy.token } })).status,
    ).toBe(200);
    expect(
      (await request("/api/private", { headers: { authorization: `Bearer ${policy.token}` } }))
        .status,
    ).toBe(200);
    expect((await request("/api/health", { headers: { host: "untrusted.example" } })).status).toBe(
      403,
    );
  });

  test("disabled login admits browser and API access without creating credentials on any allowed host", async () => {
    policy.requireLogin = false;
    policy.allowedHost = (host) => host === "localhost" || host === "app.example";
    policy.publicUrl = "https://app.example";
    const admitted: Record<string, string>[] = [
      {},
      { host: "app.example", origin: "https://app.example" },
      { origin: "https://app.example" },
      { authorization: "Bearer invalid", cookie: "r3_session=expired" },
    ];
    for (const headers of admitted) {
      const boot = await request("/api/boot", { headers });
      expect(boot.status).toBe(200);
      expect(await boot.json()).toEqual({ needsAuth: false, token: null, loginRequired: false });
      expect(boot.headers.get("set-cookie")).toBeNull();
      expect((await request("/api/private", { headers })).status).toBe(200);
      expect((await request("/api/private", { method: "POST", headers })).status).toBe(200);
      expect((await request("/api/events", { headers })).status).toBe(200);
    }
    // The owner can silence the browser notice without changing access.
    policy.disableLoginNotice = true;
    expect(await (await request("/api/boot")).json()).toEqual({
      needsAuth: false,
      token: null,
      loginRequired: false,
      loginNotice: false,
    });
    policy.disableLoginNotice = undefined;
    expect(db.query("SELECT COUNT(*) AS n FROM auth_tokens").get()).toEqual({ n: 0 });
    expect(db.query("SELECT COUNT(*) AS n FROM auth_sessions").get()).toEqual({ n: 0 });
    const forbidden: Record<string, string>[] = [
      { host: "untrusted.example" },
      { origin: "null" },
      { origin: "http://localhost:8792" },
      { origin: "https://untrusted.example" },
      { "sec-fetch-site": "cross-site" },
    ];
    for (const headers of forbidden)
      expect((await request("/api/private", { headers })).status).toBe(403);
    policy.requireLogin = true;
    expect((await request("/api/private")).status).toBe(401);
    expect(
      (await request("/api/private", { headers: { origin: "https://app.example" } })).status,
    ).toBe(401);
  });

  test.each([false, true])(
    "cross-port and preview origins stay forbidden with requireLogin=%s",
    async (requireLogin) => {
      policy.requireLogin = requireLogin;
      for (const origin of [
        "http://localhost:8792",
        "http://preview.localhost:8791",
        "null",
        "https://untrusted.example",
      ]) {
        expect((await request("/api/boot", { headers: { origin } })).status).toBe(403);
        expect(
          (
            await request("/api/private", {
              method: "POST",
              headers: { origin, "x-r3-token": policy.token },
            })
          ).status,
        ).toBe(403);
      }
      expect(
        (await request("/api/boot", { headers: { "sec-fetch-site": "same-site" } })).status,
      ).toBe(403);
      expect(
        (await request("/api/boot", { headers: { "sec-fetch-site": "same-origin" } })).status,
      ).toBe(requireLogin ? 401 : 200);
      expect(
        (
          await request("/api/private", {
            method: "POST",
            headers: { origin: "https://app.example", "x-r3-token": policy.token },
          })
        ).status,
      ).toBe(200);
    },
  );

  test("required login preserves HttpOnly cookie access without exposing the master token", async () => {
    policy.requireLogin = true;
    expect(await (await request("/api/boot")).json()).toEqual({
      needsAuth: true,
      token: null,
      loginRequired: true,
    });
    const login = authentication.createLoginToken("Browser");
    const response = await request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-proto": "https" },
      body: JSON.stringify({ token: login.token }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    const headers = { cookie: cookie.split(";", 1)[0] };
    expect(await (await request("/api/boot", { headers })).json()).toEqual({
      needsAuth: false,
      token: null,
      loginRequired: true,
    });
    expect((await request("/api/events", { headers })).status).toBe(200);
    expect(
      (await request(`/api/auth/tokens/${login.info.id}`, { method: "DELETE", headers })).status,
    ).toBe(409);
    authentication.revokeToken(login.info.id);
    expect((await request("/api/private", { headers })).status).toBe(401);
  });
});
