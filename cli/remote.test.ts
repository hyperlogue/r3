import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createArtifactApi } from "../server/artifact-api.ts";
import { openArtifactStorage } from "../server/artifact-storage.ts";
import { R3_VERSION } from "../shared/version.ts";

test("remote CLI saves access, watches directly, and delivers through only a private worker socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-remote-cli-"));
  const storage = await openArtifactStorage({
    databasePath: join(root, "backend", "store.sqlite"),
  });
  const api = createArtifactApi(storage, {
    token: randomBytes(32).toString("hex"),
    requireLogin: true,
    version: R3_VERSION,
    allowedHost: (host) => host === "127.0.0.1",
  });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: api.app.fetch });
  const cwd = join(root, "publisher"),
    bin = join(root, "bin"),
    queue = join(root, "queue.txt");
  await mkdir(cwd);
  await mkdir(bin);
  await writeFile(
    join(cwd, ".r3.json"),
    JSON.stringify({ backendUrl: `http://127.0.0.1:${server.port}` }),
  );
  await writeFile(join(cwd, "note.txt"), "Review this");
  await writeFile(
    join(bin, "codex"),
    "#!/usr/bin/env bun\nawait Bun.write(process.env.R3_TEST_QUEUE,process.argv.at(-1));\n",
  );
  await chmod(join(bin, "codex"), 0o700);
  const env = {
    ...process.env,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    R3_DB: join(root, "publisher.sqlite"),
    R3_URL: "",
    R3_TOKEN: "",
    R3_AGENT_SESSION: "remote-publisher",
    CODEX_THREAD_ID: "fixture-thread",
    CODEX_SESSION_ID: "",
    CODEX_HOME: join(root, "codex-home"),
    CODEX_PERMISSION_PROFILE: "workspace-write",
    CODEX_SANDBOX: "",
    CODEX_SANDBOX_NETWORK_DISABLED: "0",
    CLAUDE_CODE_SESSION_ID: "",
    CLAUDE_CODE_MESSAGING_SOCKET: "",
    CLAUDE_CODE_MESSAGING_TOKEN: "",
    PATH: `${bin}:${process.env.PATH}`,
    R3_TEST_QUEUE: queue,
  };
  const argv = process.env.R3_TEST_BINARY
    ? [process.env.R3_TEST_BINARY]
    : [process.execPath, join(import.meta.dir, "index.ts")];
  const run = async (args: string[], input?: string) => {
    const child = Bun.spawn([...argv, ...args], {
      cwd,
      env,
      stdin: input === undefined ? "ignore" : new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 20000);
    try {
      const [output, error, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      return { output, error, code };
    } finally {
      clearTimeout(timeout);
    }
  };
  try {
    expect((await run(["list"])).error).toContain("r3 login");
    const key = storage.clientAuth.createKey(null);
    expect((await run(["login", "--api-key-stdin"], key.token)).code).toBe(0);
    const createdKey = await run([
      "auth",
      "create-key",
      "--label",
      "fixture-key",
      "--expires-days",
      "1",
    ]);
    expect(createdKey.code).toBe(0);
    const access = storage.clientAuth.authenticate(createdKey.output.trim());
    expect(access?.expiresAt).toBeGreaterThan(Date.now());
    expect((await run(["auth", "revoke-client", access!.id])).code).toBe(0);
    expect(storage.clientAuth.authenticate(createdKey.output.trim())).toBeNull();
    const created = await run([
      "create",
      "--kind",
      "files",
      "--dir",
      ".",
      "--file",
      "note.txt",
      "--no-listen",
      "--json",
    ]);
    expect(created.code).toBe(0);
    expect(created.error).toBe("");
    const id = JSON.parse(created.output).artifact.id;
    const watched = await run(["watch", id, "--timeout", "1"]);
    expect(watched.code).toBe(2);
    expect(watched.error).toBe("");
    expect(await Bun.file(join(root, "runtime", "r3", "worker.json")).exists()).toBe(false);
    const listened = await run(["listen", id]);
    expect(listened.code).toBe(0);
    expect(listened.error).toContain("sandbox environment detected while starting the r3 worker");
    expect(listened.output).not.toContain("Warning:");
    const reused = await run(["worker", "start"]);
    expect(reused.code).toBe(0);
    expect(reused.error).toBe("");
    const info = await Bun.file(join(root, "runtime", "r3", "worker.json")).json();
    expect(info.socket.endsWith("worker.sock")).toBe(true);
    expect(info.port).toBeUndefined();
    expect(await Bun.file(join(root, "runtime", "r3", "daemon.json")).exists()).toBe(false);
    expect(await Bun.file(join(root, "publisher.sqlite")).exists()).toBe(false);
    expect((await api.collaboration.submit(id)).state).toBe("queued");
    expect(await Bun.file(queue).text()).toContain(`r3 comment fetch ${id}`);
    expect((await run(["worker", "stop"])).code).toBe(0);
    for (
      let i = 0;
      i < 100 && api.collaboration.watchers(id)[0]?.connectionState !== "disconnected";
      i++
    )
      await Bun.sleep(20);
    expect(api.collaboration.watchers(id)[0]?.connectionState).toBe("disconnected");
    env.CODEX_PERMISSION_PROFILE = "danger-full-access";
    const restarted = await run(["worker", "start"]);
    expect(restarted.code).toBe(0);
    expect(restarted.error).toBe("");
    for (
      let i = 0;
      i < 100 && api.collaboration.watchers(id)[0]?.connectionState !== "connected";
      i++
    )
      await Bun.sleep(20);
    expect(api.collaboration.watchers(id)[0]?.actor.sessionId).toBe("remote-publisher");
    expect((await run(["unlisten", id])).code).toBe(0);
    expect(api.collaboration.watchers(id)).toEqual([]);
  } finally {
    await run(["worker", "stop"]);
    api.close();
    await server.stop(true);
    storage.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
