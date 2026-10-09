import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BackendCredentials } from "./backend.ts";

test("device login uses the five-second default when the backend omits interval", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-device-default-"));
  let started = 0,
    polled = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request): Promise<Response> {
      if (new URL(request.url).pathname.endsWith("/device/code")) {
        started = Date.now();
        return Response.json({
          device_code: "test-device",
          user_code: "TEST-CODE",
          expires_in: 30,
          verification_uri: `${server.url.origin}/authorize`,
        });
      }
      polled = Date.now();
      expect((await request.formData()).get("device_code")).toBe("test-device");
      return Response.json({
        access_token: "access",
        refresh_token: "refresh",
        token_type: "Bearer",
        expires_in: 900,
      });
    },
  });
  try {
    const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "index.ts"), "login"], {
      cwd: root,
      env: {
        ...process.env,
        R3_URL: server.url.origin,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_RUNTIME_DIR: join(root, "runtime"),
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 12_000,
    });
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(0);
    expect(error).toBe("");
    expect(polled - started).toBeGreaterThanOrEqual(4900);
    expect(
      new BackendCredentials(join(root, "config", "r3", "credentials")).read(server.url.origin)
        ?.accessToken,
    ).toBe("access");
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
