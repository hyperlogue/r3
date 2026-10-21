import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a loopback-only server skips login unless opted in; exposure always requires it", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-login-policy-"));
  const config = join(root, "config", "r3");
  await mkdir(config, { recursive: true });
  const cases: {
    config: object;
    env?: Record<string, string>;
    required: boolean;
    refuseProxied?: boolean;
    refused?: boolean;
    localUrl?: string;
  }[] = [
    { config: {}, required: false, refuseProxied: true },
    { config: { publicUrl: "http://localhost:8791" }, required: false, refuseProxied: true },
    { config: { requireLogin: true }, required: true },
    { config: {}, env: { R3_REQUIRE_LOGIN: "true" }, required: true },
    { config: { publicUrl: "https://reviews.example" }, required: true },
    { config: { trustedProxies: ["127.0.0.1"] }, required: true },
    { config: {}, env: { R3_BIND: "100.64.0.1" }, required: true },
    { config: { allowedHosts: ["reviews.example"] }, required: true },
    { config: {}, env: { R3_ALLOWED_HOSTS: "reviews.example" }, required: true },
    // Wildcard binds and unrecognized spellings of loopback count as exposure.
    { config: {}, env: { R3_BIND: "0.0.0.0" }, required: true },
    { config: {}, env: { R3_BIND: "::" }, required: true },
    { config: { publicUrl: "http://localhost.:8791" }, required: true },
    { config: {}, env: { R3_PUBLIC_URL: "not a url" }, required: true },
    {
      config: {},
      env: { R3_BIND: "::1" },
      required: false,
      refuseProxied: true,
      localUrl: "http://[::1]:8791",
    },
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
    {
      config: { requireLogin: true },
      env: { R3_REQUIRE_LOGIN: "false" },
      required: false,
      refuseProxied: true,
    },
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
    {
      config: { requireLogin: false },
      env: { R3_PUBLIC_URL: "not a url" },
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
          'import { LOCAL_URL, LOGIN_POLICY_ERROR, REFUSE_PROXIED, REQUIRE_LOGIN } from "./config.ts"; console.log(REQUIRE_LOGIN, REFUSE_PROXIED, LOGIN_POLICY_ERROR !== null, LOCAL_URL)',
        ],
        {
          cwd: import.meta.dir,
          env: {
            ...process.env,
            XDG_CONFIG_HOME: join(root, "config"),
            XDG_STATE_HOME: join(root, "state"),
            XDG_RUNTIME_DIR: join(root, "runtime"),
            R3_BIND: "127.0.0.1",
            R3_PORT: "8791",
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
      const [required, refuseProxied, refused, localUrl] = out.trim().split(" ");
      expect({
        config: item.config,
        env: item.env,
        policy: [required, refuseProxied, refused],
      }).toEqual({
        config: item.config,
        env: item.env,
        policy: [`${item.required}`, `${item.refuseProxied ?? false}`, `${item.refused ?? false}`],
      });
      if (item.localUrl) expect(localUrl).toBe(item.localUrl);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
