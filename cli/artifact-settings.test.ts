import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("an unknown config subcommand reports usage, not a config-name error", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-config-usage-"));
  try {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "index.ts"), "config", "lsit"],
      {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_STATE_HOME: join(root, "state"),
          XDG_RUNTIME_DIR: join(root, "runtime"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [error, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(1);
    expect(error).toContain("config show|get|set|unset");
    expect(error).not.toContain("Config name must be one of");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("token inactivity config round-trips, validates days and sanitizes hand-edited values", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-auth-config-"));
  const configHome = join(root, "config");
  const file = join(configHome, "r3", "config.json");
  const run = async (...args: string[]) => {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "index.ts"), "config", ...args],
      {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: configHome,
          XDG_STATE_HOME: join(root, "state"),
          XDG_RUNTIME_DIR: join(root, "runtime"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { output, error, code };
  };
  try {
    expect((await run("set", "authTokenIdleDays", "30")).code).toBe(0);
    expect((await run("get", "authTokenIdleDays")).output.trim()).toBe("30");
    expect(await Bun.file(file).json()).toEqual({ authTokenIdleDays: 30 });
    for (const invalid of [
      "0",
      "-1",
      "1.5",
      "NaN",
      "Infinity",
      "9007199254740992",
      "3e1",
      "0x1e",
    ]) {
      const result = await run("set", "authTokenIdleDays", invalid);
      expect(result.code).toBe(1);
      expect(result.error).toContain("positive integer");
      expect(await Bun.file(file).json()).toEqual({ authTokenIdleDays: 30 });
    }
    expect((await run("unset", "authTokenIdleDays")).code).toBe(0);
    expect((await run("get", "authTokenIdleDays")).output).toBe("");
    await mkdir(join(configHome, "r3"), { recursive: true });
    for (const invalid of ["30", 0, -1, 1.5, null]) {
      await writeFile(file, JSON.stringify({ requireLogin: true, authTokenIdleDays: invalid }));
      expect(JSON.parse((await run("show")).output)).toEqual({ requireLogin: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive TTL persists independently and rejects unsafe values", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-gc-config-"));
  const run = async (...args: string[]) => {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "index.ts"), "config", ...args],
      {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_STATE_HOME: join(root, "state"),
          XDG_RUNTIME_DIR: join(root, "runtime"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return { output, code };
  };
  try {
    expect((await run("set", "archiveTtlDays", "7")).code).toBe(0);
    expect((await run("get", "archiveTtlDays")).output.trim()).toBe("7");
    for (const invalid of ["0", "-1", "1.5", "36501", "7d", "Infinity", "1e2", "0x10", "+7"])
      expect((await run("set", "archiveTtlDays", invalid)).code).toBe(1);
    expect((await run("get", "archiveTtlDays")).output.trim()).toBe("7");
    expect((await run("unset", "archiveTtlDays")).code).toBe(0);
    expect(JSON.parse((await run("show")).output)).toEqual({});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("config set refuses to overwrite a config.json it cannot read", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-unreadable-config-"));
  const configHome = join(root, "config");
  // A directory where config.json should be: readFileSync fails with EISDIR,
  // which must not be mistaken for "absent".
  await mkdir(join(configHome, "r3", "config.json"), { recursive: true });
  try {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "index.ts"), "config", "set", "archiveTtlDays", "7"],
      {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: configHome,
          XDG_STATE_HOME: join(root, "state"),
          XDG_RUNTIME_DIR: join(root, "runtime"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [error, code] = await Promise.all([new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(1);
    expect(error).toContain("unreadable or invalid JSON");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("config set never disables login on an exposed server", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-login-exposure-"));
  const run = async (...args: string[]) => {
    const child = Bun.spawn(
      [process.execPath, join(import.meta.dir, "index.ts"), "config", ...args],
      {
        env: {
          ...process.env,
          XDG_CONFIG_HOME: join(root, "config"),
          XDG_STATE_HOME: join(root, "state"),
          XDG_RUNTIME_DIR: join(root, "runtime"),
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [output, error, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    return { output, error, code };
  };
  try {
    expect((await run("set", "requireLogin", "false")).code).toBe(0);
    for (const [name, value] of [
      ["publicUrl", "https://reviews.example"],
      ["allowedHosts", "reviews.example"],
      ["trustedProxies", "127.0.0.1"],
      ["bind", "100.64.0.1"],
    ]) {
      const refused = await run("set", name!, value!);
      expect({ name, code: refused.code }).toEqual({ name, code: 1 });
      expect(refused.error).toContain("requireLogin=false is allowed only");
    }
    expect((await run("unset", "requireLogin")).code).toBe(0);
    expect((await run("set", "publicUrl", "https://reviews.example")).code).toBe(0);
    expect((await run("set", "requireLogin", "false")).error).toContain(
      "requireLogin=false is allowed only",
    );
    expect(JSON.parse((await run("show")).output)).toEqual({
      publicUrl: "https://reviews.example",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
