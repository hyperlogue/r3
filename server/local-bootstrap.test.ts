import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { localBootstrap } from "../cli/local-bootstrap.ts";
import { createArtifactApi } from "./artifact-api.ts";
import { type ArtifactStorage, openArtifactStorage } from "./artifact-storage.ts";
import { startLocalBootstrap } from "./local-bootstrap.ts";

let root: string,
  socket: string,
  storage: ArtifactStorage,
  api: ReturnType<typeof createArtifactApi>,
  bootstrap: ReturnType<typeof startLocalBootstrap>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-local-bootstrap-"));
  socket = join(root, "private", "bootstrap.sock");
  storage = await openArtifactStorage({ databasePath: join(root, "store.sqlite") });
  api = createArtifactApi(storage, {
    token: "local-api-secret",
    requireLogin: true,
    version: "test",
    allowedHost: (host) => host === "localhost",
  });
  bootstrap = startLocalBootstrap({
    socket,
    url: "http://localhost:8000",
    publicUrl: "http://localhost:8000",
    token: "local-api-secret",
  });
});
afterEach(async () => {
  await bootstrap.stop();
  api.close();
  storage.close();
  await rm(root, { recursive: true, force: true });
});
function http(path: string, method = "GET", body?: unknown, extra: Record<string, string> = {}) {
  return api.app.request(`http://localhost${path}`, {
    method,
    headers: { host: "localhost", "content-type": "application/json", ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("only an owner-only Unix socket supplies automatic local access", async () => {
  expect((await lstat(socket)).mode & 0o777).toBe(0o600);
  expect((await lstat(join(root, "private"))).mode & 0o777).toBe(0o700);
  expect(await localBootstrap(socket, "bootstrap")).toMatchObject({ token: "local-api-secret" });
  const browserHeaders: Record<string, string>[] = [
    { origin: "http://localhost" },
    { origin: "null" },
    { "sec-fetch-site": "same-origin" },
  ];
  for (const headers of browserHeaders) {
    const response = await fetch("http://localhost/api/local/bootstrap", {
      unix: socket,
      method: "POST",
      headers,
    });
    expect(response.status).toBe(403);
  }
  expect((await http("/api/local/bootstrap", "POST", {})).status).toBe(401);
  const boot = await http("/api/boot");
  expect(boot.status).toBe(401);
  expect(await boot.json()).toEqual({ needsAuth: true, token: null, loginRequired: true });
  await chmod(socket, 0o666);
  await expect(localBootstrap(socket, "bootstrap")).rejects.toThrow("owner-only");
  await chmod(socket, 0o600);
  const alias = join(root, "private", "alias.sock");
  await symlink(socket, alias);
  await expect(localBootstrap(alias, "bootstrap")).rejects.toThrow("owner-only");
});

test("browser links are stable URLs and create no browser credentials", async () => {
  const result = await localBootstrap<{ url: string }>(socket, "browser", {
    path: "/artifact_example",
  });
  expect(result.url).toBe("http://localhost:8000/artifact_example");
  expect(
    await localBootstrap<{ url: string }>(socket, "browser", { path: "/artifact_example" }),
  ).toEqual(result);
  expect(storage.authentication.listTokens()).toEqual([]);
  expect((await http("/api/boot")).status).toBe(401);
  await expect(localBootstrap(socket, "browser", { path: "//other.example" })).rejects.toThrow(
    "setup failed",
  );
});

test("local API credentials cannot approve remote clients without browser authentication", async () => {
  const result = await http(
    "/api/oauth/device/inspect",
    "POST",
    { userCode: "anything" },
    { "x-r3-token": "local-api-secret" },
  );
  expect(result.status).toBe(401);
  expect((await result.json()).error).toContain("authenticated r3 browser");
});
