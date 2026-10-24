import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("server start reports the actual startup failure and its discovery context", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-startup-error-"));
  const occupied = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    R3_DB: join(root, "store.sqlite"),
    R3_PORT: String(occupied.port),
    R3_BIND: "127.0.0.1",
    R3_PUBLIC_URL: "",
    R3_ALLOWED_HOSTS: "",
    R3_REQUIRE_LOGIN: "",
    R3_AUTH_TOKEN_IDLE_DAYS: "",
    R3_PROJECT_GROUPING: "",
  };
  async function run(...args: string[]) {
    const child = Bun.spawn([process.execPath, join(import.meta.dir, "index.ts"), ...args], {
      env,
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 15_000,
    });
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, output, error };
  }
  try {
    const failed = await run("server", "start");
    expect(failed.code).toBe(1);
    expect(failed.error).toContain("port");
    expect(failed.error).toContain(String(occupied.port));
    expect(failed.error).toContain(join(root, "runtime", "r3", "daemon.json"));
    await occupied.stop(true);
    // The startup error channel must close: the CLI exits while its daemon lives.
    const started = await run("server", "start");
    expect(started.code).toBe(0);
    expect(started.error).toBe("");
    expect(started.output).toContain("server started:");
    expect((await run("server", "status")).output).toContain("r3 server:");
  } finally {
    await run("server", "stop");
    await occupied.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);

for (const legacy of [false, true]) {
  test(`restart preserves discovery across missing runtime configuration (legacy: ${legacy})`, async () => {
    const root = await mkdtemp(join(tmpdir(), "r3-runtime-restart-"));
    const system = join(root, "system");
    const state = join(root, "state", "r3");
    await mkdir(system, { mode: 0o700 });
    await mkdir(state, { recursive: true, mode: 0o700 });
    const preload = join(root, "system-runtime.ts");
    // Substitute only the OS-provided directory, never server/discovery behavior.
    // This runs real CLI/daemon processes without consulting the user's runtime.
    const module = JSON.stringify(join(import.meta.dir, "../server/runtime-directory.ts"));
    await writeFile(
      preload,
      `import { mock } from "bun:test";
import { resolveRuntimeDirectory } from ${module};
const resolve = resolveRuntimeDirectory;
mock.module(${module}, () => ({
  resolveRuntimeDirectory: options => resolve({ ...options, system: ${JSON.stringify(system)} }),
}));`,
    );
    const port = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const env = {
      ...process.env,
      XDG_CONFIG_HOME: join(root, "config"),
      XDG_STATE_HOME: join(root, "state"),
      XDG_RUNTIME_DIR: undefined as string | undefined,
      R3_DB: join(root, "store.sqlite"),
      R3_PORT: String(port.port),
      R3_BIND: "127.0.0.1",
      R3_PUBLIC_URL: "",
      R3_ALLOWED_HOSTS: "",
      R3_REQUIRE_LOGIN: "",
    };
    await port.stop(true);
    async function run(command: string, runtime?: string) {
      const child = Bun.spawn(
        [
          process.execPath,
          "--preload",
          preload,
          join(import.meta.dir, "index.ts"),
          "server",
          command,
        ],
        {
          env: { ...env, XDG_RUNTIME_DIR: runtime },
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
          timeout: 15_000,
        },
      );
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      expect(error).toBe("");
      expect(code).toBe(0);
      return output;
    }
    const runtime = legacy ? join(root, "state") : system;
    const announcement = Bun.file(join(runtime, "r3", "daemon.json"));
    try {
      await run("start", runtime);
      const before = await announcement.json();
      expect(await run("status")).toContain("r3 server:");
      expect(await run("start")).toContain("already running");
      expect((await announcement.json()).pid).toBe(before.pid);
      expect(await run("restart")).toContain("r3 server stopped");
      expect((await announcement.json()).pid).not.toBe(before.pid);
      expect(await run("status", runtime)).toContain("r3 server:");
    } finally {
      try {
        await run("stop", runtime);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }, 45_000);
}
