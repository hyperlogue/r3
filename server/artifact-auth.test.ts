import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { Hono } from "hono";
import { type ArtifactAuthPolicy, installArtifactAuth } from "./artifact-auth.ts";
import { createArtifactTables } from "./artifact-schema.ts";
import { AuthService } from "./auth.ts";

let db: Database;
let authentication: AuthService;
let app: Hono;
let policy: ArtifactAuthPolicy;
beforeEach(() => {
  db = new Database(":memory:");
  createArtifactTables(db);
  authentication = new AuthService(db);
  policy = {
    token: randomBytes(32).toString("base64url"),
    requireLogin: false,
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
  test("only local same-origin bootstrap exposes the token and every data stream requires authentication", async () => {
    expect(await (await request("/api/boot")).json()).toEqual({
      needsAuth: false,
      token: policy.token,
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

  test("cross-port and preview origins cannot bootstrap or mutate even on an allowed hostname", async () => {
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
    ).toBe(200);
    expect(
      (
        await request("/api/private", {
          method: "POST",
          headers: { origin: "https://app.example", "x-r3-token": policy.token },
        })
      ).status,
    ).toBe(200);
  });

  test("required login preserves HttpOnly cookie access without exposing the master token", async () => {
    policy.requireLogin = true;
    expect(await (await request("/api/boot")).json()).toEqual({ needsAuth: true, token: null });
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
    });
    expect((await request("/api/events", { headers })).status).toBe(200);
    expect(
      (await request(`/api/auth/tokens/${login.info.id}`, { method: "DELETE", headers })).status,
    ).toBe(409);
    authentication.revokeToken(login.info.id);
    expect((await request("/api/private", { headers })).status).toBe(401);
  });
});
