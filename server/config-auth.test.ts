import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("login is required unless explicitly disabled on a loopback-only server", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-login-policy-"));
  const config = join(root, "config", "r3");
  await mkdir(config, { recursive: true });
  const cases: {
    config: object;
    env?: Record<string, string>;
    required: boolean;
    refuseProxied?: boolean;
    refused?: boolean;
  }[] = [
    { config: {}, required: true },
    { config: { publicUrl: "http://localhost:8791" }, required: true },
    { config: { requireLogin: true }, required: true },
    { config: { requireLogin: false }, required: false, refuseProxied: true },
    {
      config: { requireLogin: false, publicUrl: "http://localhost:8791" },
      required: false,
      refuseProxied: true,
    },
    {
      config: { requireLogin: false, allowedHosts: ["localhost", "127.0.0.1", "[::1]"] },
      required: false,
      refuseProxied: true,
    },
    { config: {}, env: { R3_REQUIRE_LOGIN: "false" }, required: false, refuseProxied: true },
    { config: { requireLogin: false }, env: { R3_REQUIRE_LOGIN: "true" }, required: true },
    // Exposure can never run without login, whichever layer disables it.
    {
      config: { requireLogin: false, publicUrl: "https://reviews.example" },
      required: true,
      refused: true,
    },
    {
      config: { requireLogin: false, allowedHosts: ["reviews.example"] },
      required: true,
      refused: true,
    },
    {
      config: { requireLogin: false, trustedProxies: ["127.0.0.1"] },
      required: true,
      refused: true,
    },
    {
      config: { requireLogin: false },
      env: { R3_BIND: "100.64.0.1" },
      required: true,
      refused: true,
    },
    {
      config: {},
      env: { R3_REQUIRE_LOGIN: "false", R3_PUBLIC_URL: "https://reviews.example" },
      required: true,
      refused: true,
    },
    {
      config: { requireLogin: false },
      env: { R3_ALLOWED_HOSTS: "reviews.example" },
      required: true,
      refused: true,
    },
  ];
  try {
    for (const item of cases) {
      await writeFile(join(config, "config.json"), JSON.stringify(item.config));
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          'import { LOGIN_POLICY_ERROR, REFUSE_PROXIED, REQUIRE_LOGIN } from "./config.ts"; console.log(REQUIRE_LOGIN, REFUSE_PROXIED, LOGIN_POLICY_ERROR !== null)',
        ],
        {
          cwd: import.meta.dir,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: join(root, "config"),
            XDG_STATE_HOME: join(root, "state"),
            XDG_RUNTIME_DIR: join(root, "runtime"),
            R3_BIND: "127.0.0.1",
            R3_PUBLIC_URL: "",
            R3_REQUIRE_LOGIN: "",
            R3_ALLOWED_HOSTS: undefined,
            ...item.env,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [out, err, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect({ code, err }).toEqual({ code: 0, err: "" });
      expect({ config: item.config, env: item.env, out: out.trim() }).toEqual({
        config: item.config,
        env: item.env,
        out: `${item.required} ${item.refuseProxied ?? false} ${item.refused ?? false}`,
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
