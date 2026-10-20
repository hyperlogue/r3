import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("login defaults follow configured exposure and explicit overrides win", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-login-policy-"));
  const config = join(root, "config", "r3");
  await mkdir(config, { recursive: true });
  const cases: { config: object; env?: Record<string, string>; required: boolean }[] = [
    { config: {}, required: false },
    { config: { publicUrl: "http://localhost:8791" }, required: false },
    { config: { allowedHosts: ["localhost", "127.0.0.1", "[::1]"] }, required: false },
    { config: { publicUrl: "https://reviews.example" }, required: true },
    { config: { allowedHosts: ["reviews.example"] }, required: true },
    { config: { requireLogin: true }, required: true },
    { config: { publicUrl: "https://reviews.example", requireLogin: false }, required: false },
    { config: { allowedHosts: ["reviews.example"], requireLogin: false }, required: false },
    { config: { requireLogin: true }, env: { R3_REQUIRE_LOGIN: "false" }, required: false },
    { config: { requireLogin: false }, env: { R3_REQUIRE_LOGIN: "true" }, required: true },
    { config: {}, env: { R3_PUBLIC_URL: "https://reviews.example" }, required: true },
    { config: {}, env: { R3_ALLOWED_HOSTS: "reviews.example" }, required: true },
  ];
  try {
    for (const item of cases) {
      await writeFile(join(config, "config.json"), JSON.stringify(item.config));
      const child = Bun.spawn(
        [
          process.execPath,
          "-e",
          'import { REQUIRE_LOGIN } from "./config.ts"; console.log(REQUIRE_LOGIN)',
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
      expect(out.trim()).toBe(String(item.required));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
