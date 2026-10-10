import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeBackendUrl } from "../shared/backend-url.ts";
import { type BackendCredential, BackendCredentials, selectedBackend } from "./backend.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "r3-backends-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
test("backend precedence uses working directory and stops at the repository boundary", () => {
  const project = join(root, "project"),
    nested = join(project, "nested"),
    user = join(root, "config.json");
  mkdirSync(nested, { recursive: true });
  mkdirSync(join(project, ".git"));
  writeFileSync(user, JSON.stringify({ backendUrl: "https://default.example" }));
  writeFileSync(join(root, ".r3.json"), JSON.stringify({ backendUrl: "https://outside.example" }));
  expect(selectedBackend(nested, {}, user)).toBe("https://default.example");
  writeFileSync(
    join(project, ".r3.json"),
    JSON.stringify({ backendUrl: "https://project.example/app/" }),
  );
  expect(selectedBackend(nested, {}, user)).toBe("https://project.example/app");
  expect(selectedBackend(nested, { R3_URL: "https://override.example" }, user)).toBe(
    "https://override.example",
  );
  writeFileSync(join(project, ".r3.json"), "invalid");
  expect(() => selectedBackend(nested, {}, user)).toThrow("Invalid project");
});
test("endpoint identity is exact and cleartext is restricted to loopback", () => {
  expect(normalizeBackendUrl("https://R3.example:443/app/")).toBe("https://r3.example/app");
  for (const url of [
    "http://r3.example",
    "https://r3.example/#x",
    "https://r3.example/?x=1",
    "https://r3.example/a%2Fb",
  ])
    expect(() => normalizeBackendUrl(url)).toThrow();
  expect(normalizeBackendUrl("http://localhost:8791/")).toBe("http://localhost:8791");
});
test("two credential readers coordinate a single refresh and keep endpoint credentials separate", async () => {
  let calls = 0;
  const access = randomBytes(32).toString("base64url"),
    refresh = randomBytes(32).toString("base64url");
  const send = (async (url: unknown, options: RequestInit) => {
    calls++;
    expect(String(url)).toBe("https://r3.example/app/api/oauth/token");
    expect(options.redirect).toBe("error");
    await Bun.sleep(25);
    return Response.json({
      access_token: access,
      refresh_token: refresh,
      expires_in: 900,
      token_type: "Bearer",
    });
  }) as typeof fetch;
  const directory = join(root, "credentials");
  const first = new BackendCredentials(directory, send),
    second = new BackendCredentials(directory, send);
  await first.save({
    url: "https://r3.example/app/",
    kind: "oauth",
    accessToken: randomBytes(32).toString("hex"),
    refreshToken: randomBytes(32).toString("hex"),
    expiresAt: 0,
  });
  const values = await Promise.all([
    first.token("https://r3.example/app"),
    second.token("https://r3.example/app"),
  ]);
  expect(calls).toBe(1);
  expect(values.every((value) => value === access)).toBe(true);
  expect(first.read("https://r3.example/other")).toBeNull();
  expect(first.read("https://other.example/app")).toBeNull();
  await expect(first.token("https://other.example/app")).rejects.toThrow("run r3 login");
});

for (const status of [400, 401, 408, 429, 503]) {
  test(`refresh HTTP ${status} preserves credentials and distinguishes temporary failure from rejection`, async () => {
    const url = "https://r3.example";
    const original: BackendCredential = {
      url,
      kind: "oauth",
      accessToken: randomBytes(32).toString("hex"),
      refreshToken: randomBytes(32).toString("hex"),
      expiresAt: 0,
    };
    const credentials = new BackendCredentials(join(root, "credentials"), (async (
      _url: unknown,
      _options: RequestInit,
    ) =>
      Response.json(
        { error: status === 400 ? "invalid_grant" : "Request failed" },
        { status },
      )) as typeof fetch);
    await credentials.save(original);
    await expect(credentials.token(url)).rejects.toThrow(
      status === 400 || status === 401 ? "run r3 login" : "temporarily unavailable",
    );
    expect(credentials.read(url)).toEqual(original);
  });
}
