import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { R3_VERSION } from "../shared/version.ts";
import { serverCompatibility } from "./server-compatibility.ts";

test("release diagnostics distinguish direction and server management location", () => {
  for (const local of [true, false]) {
    for (const protocol of ["artifacts-v3", "artifacts-v2", undefined]) {
      const older = serverCompatibility(
        { ok: true, version: "0.0.0", protocol },
        "https://r3.example",
        local,
      );
      expect(older.compatible).toBe(protocol === "artifacts-v3");
      expect(older.message).toContain("CLI is newer");
      expect(older.message).toContain("Ask the user to confirm");
      expect(older.message).toContain(
        local ? "this newer CLI on this machine" : "on the server's machine",
      );
      const newer = serverCompatibility(
        { ok: true, version: "9999.0.0", protocol },
        "https://r3.example",
        local,
      );
      expect(newer.message).toContain("server is newer");
      expect(newer.message).toContain("Upgrade or switch the CLI");
      expect(newer.message).not.toContain("r3 server restart");
    }
  }
  expect(
    serverCompatibility(
      { ok: true, version: R3_VERSION, protocol: "artifacts-v3" },
      "http://localhost",
      true,
    ).message,
  ).toBeNull();
  for (const version of [undefined, "development", `${R3_VERSION}+different`]) {
    const result = serverCompatibility(
      { ok: true, version, protocol: "artifacts-v3" },
      "http://localhost",
      true,
    );
    expect(result.compatible).toBe(true);
    expect(result.message).toContain("do not identify which build");
    expect(result.message).toContain("ask the user to confirm");
  }
});

test("local start and status diagnose mismatches without replacing the daemon", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-version-cli-"));
  let version = "0.0.0";
  let protocol = "artifacts-v3";
  const requests: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(new URL(request.url).pathname);
      return Response.json({ ok: true, version, protocol });
    },
  });
  const runtime = join(root, "runtime");
  const announcement = join(runtime, "r3", "daemon.json");
  await mkdir(join(runtime, "r3"), { recursive: true });
  const saved = JSON.stringify({
    url: `http://127.0.0.1:${server.port}`,
    port: server.port,
    pid: process.pid,
    version,
  });
  await writeFile(announcement, saved);
  const run = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "index.ts"), ...args], {
      cwd: root,
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(root, "config"),
        XDG_STATE_HOME: join(root, "state"),
        XDG_RUNTIME_DIR: runtime,
        R3_DB: join(root, "unused.sqlite"),
        R3_URL: "",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    });
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, output, error };
  };
  try {
    for (const release of ["0.0.0", "9999.0.0"]) {
      version = release;
      for (const command of ["start", "status"]) {
        const result = await run("server", command);
        expect(result.code).toBe(0);
        expect(result.output).toContain(command === "start" ? "already running" : `v${release}`);
        expect(result.error).toContain(
          release === "0.0.0" ? "Ask the user to confirm" : "Upgrade or switch the CLI",
        );
      }
    }
    protocol = "artifacts-v2";
    requests.length = 0;
    const blocked = await run("create", "--kind", "files", "--dir", root, "--no-listen");
    expect(blocked.code).toBe(1);
    expect(blocked.output).toBe("");
    expect(blocked.error).toContain("Incompatible backend protocol");
    expect(requests).toEqual(["/api/health"]);
    expect(await Bun.file(announcement).text()).toBe(saved);
    expect(await Bun.file(join(root, "unused.sqlite")).exists()).toBe(false);
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
