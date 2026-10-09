import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactApi } from "./artifact-api.ts";
import { type ArtifactStorage, openArtifactStorage } from "./artifact-storage.ts";

let root: string, storage: ArtifactStorage, api: ReturnType<typeof createArtifactApi>, now: number;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-client-auth-api-"));
  now = Date.now();
  storage = await openArtifactStorage({
    databasePath: join(root, "store.sqlite"),
    clock: () => new Date(now).toISOString(),
  });
  api = createArtifactApi(storage, {
    token: randomBytes(32).toString("hex"),
    requireLogin: true,
    version: "fixture",
    allowedHost: (host) => host === "r3.example",
  });
});
afterEach(async () => {
  api.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
});
function request(path: string, body: unknown, extra: HeadersInit = {}, form = false) {
  return api.app.request(
    new Request(`https://r3.example${path}`, {
      method: "POST",
      headers: {
        host: "r3.example",
        "content-type": form ? "application/x-www-form-urlencoded" : "application/json",
        ...Object.fromEntries(new Headers(extra)),
      },
      body: form ? String(body) : JSON.stringify(body),
    }),
  );
}
test("device approval requires a browser session and preserves Host and Origin guards", async () => {
  const denied = await request(
    "/api/oauth/device/code",
    new URLSearchParams({ client_id: "r3-cli" }),
    { origin: "null" },
    true,
  );
  expect(denied.status).toBe(403);
  expect(
    (
      await request(
        "/api/oauth/device/code",
        new URLSearchParams({ client_id: "r3-cli" }),
        { host: "untrusted.example" },
        true,
      )
    ).status,
  ).toBe(403);
  const started = await request(
    "/api/oauth/device/code",
    new URLSearchParams({ client_id: "r3-cli" }),
    {},
    true,
  );
  expect(started.status).toBe(200);
  expect(started.headers.get("cache-control")).toBe("no-store");
  const device = await started.json();
  const key = storage.clientAuth.createKey(null);
  const decision = { userCode: device.user_code, approved: true };
  expect((await request("/api/oauth/device/decision", decision)).status).toBe(401);
  expect(
    (await request("/api/oauth/device/decision", decision, { "x-r3-token": key.token })).status,
  ).toBe(401);
  const login = storage.authentication.createLoginToken(null);
  const session = await request("/api/auth/login", { token: login.token });
  const cookie = session.headers.get("set-cookie")!.split(";")[0];
  expect(
    (
      await request("/api/oauth/device/decision", decision, {
        cookie,
        origin: "https://untrusted.example",
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await request("/api/oauth/device/decision", decision, {
        cookie,
        origin: "https://r3.example",
      })
    ).status,
  ).toBe(200);
  now += 5000;
  const issued = await request(
    "/api/oauth/token",
    new URLSearchParams({
      client_id: "r3-cli",
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      device_code: device.device_code,
    }),
    {},
    true,
  );
  expect(issued.status).toBe(200);
  expect(issued.headers.get("pragma")).toBe("no-cache");
  const tokens = await issued.json();
  expect(storage.clientAuth.authenticate(tokens.access_token)).not.toBeNull();
  expect(JSON.stringify(storage.clientAuth.auditLog())).not.toContain(tokens.access_token);
  expect((await request("/api/oauth/device/decision", decision, { cookie })).status).toBe(404);
});
test("OAuth public routes bound form data and reject duplicate parameters", async () => {
  expect(
    (await request("/api/oauth/token", "client_id=r3-cli&client_id=r3-cli", {}, true)).status,
  ).toBe(400);
  expect(
    (await request("/api/oauth/token", `client_id=r3-cli&extra=${"x".repeat(8192)}`, {}, true))
      .status,
  ).toBe(413);
  expect((await request("/api/oauth/token", {}, {})).status).toBe(400);
});

test("malformed OAuth requests return protocol error codes", async () => {
  for (const body of [
    "client_id=r3-cli&grant_type=urn:ietf:params:oauth:grant-type:device_code",
    "client_id=r3-cli&grant_type=refresh_token",
    "client_id=r3-cli&client_id=r3-cli",
  ]) {
    const response = await request("/api/oauth/token", body, {}, true);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_request" });
    expect(response.headers.get("pragma")).toBe("no-cache");
  }
  const unknown = await request("/api/oauth/device/code", "client_id=unknown", {}, true);
  expect(await unknown.json()).toEqual({ error: "invalid_client" });
});
