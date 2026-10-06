import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    for (const invalid of ["0", "-1", "1.5", "NaN", "Infinity", "9007199254740992"]) {
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
    for (const invalid of ["0", "-1", "1.5", "36501", "7d", "Infinity"])
      expect((await run("set", "archiveTtlDays", invalid)).code).toBe(1);
    expect((await run("get", "archiveTtlDays")).output.trim()).toBe("7");
    expect((await run("unset", "archiveTtlDays")).code).toBe(0);
    expect(JSON.parse((await run("show")).output)).toEqual({});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
