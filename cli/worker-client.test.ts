import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateJson } from "./private-state.ts";
import { workerSandboxWarning } from "./worker-client.ts";

test("worker startup recognizes sandbox hints without treating agent identity as a sandbox", () => {
  for (const env of [
    { CODEX_PERMISSION_PROFILE: "workspace-write" },
    { CODEX_PERMISSION_PROFILE: "read-only" },
    { CODEX_SANDBOX: "seatbelt" },
    { CODEX_SANDBOX_NETWORK_DISABLED: "1" },
    { CODEX_PERMISSION_PROFILE: "danger-full-access", CODEX_SANDBOX: "seatbelt" },
  ]) {
    const warning = workerSandboxWarning(env);
    expect(warning).toContain("inherits this CLI's permissions");
    expect(warning).toContain("notifications may fail");
    expect(warning).toContain("`r3 worker restart` from a terminal outside the sandbox");
  }
  for (const env of [
    {},
    { CODEX_THREAD_ID: "fixture-thread", CODEX_SESSION_ID: "fixture-session" },
    { CLAUDE_CODE_SESSION_ID: "fixture-session" },
    {
      CODEX_PERMISSION_PROFILE: "danger-full-access",
      CODEX_SANDBOX: "",
      CODEX_SANDBOX_NETWORK_DISABLED: "0",
    },
  ]) {
    expect(workerSandboxWarning(env)).toBeNull();
  }
});

test("worker discovery trusts authenticated IPC even when its PID is outside this namespace", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-worker-discovery-"));
  const socket = join(root, "worker.sock");
  const token = crypto.randomUUID();
  const server = Bun.serve({
    unix: socket,
    fetch(request) {
      return request.headers.get("x-r3-token") === token
        ? Response.json({ workerId: "existing-worker" })
        : new Response(null, { status: 403 });
    },
  });
  await chmod(socket, 0o600);
  try {
    writePrivateJson(join(root, "r3", "worker.json"), { pid: 2147483647, socket, token });
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `import { existingWorker } from ${JSON.stringify(join(import.meta.dir, "worker-client.ts"))}; const client = await existingWorker(); console.log(client ? (await client.json("GET", "/api/local/status")).workerId : "missing");`,
      ],
      {
        env: { ...process.env, XDG_RUNTIME_DIR: root },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(output.trim()).toBe("existing-worker");
  } finally {
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});

async function workerFixture() {
  const root = await mkdtemp(join(tmpdir(), "r3-worker-lifecycle-"));
  const env = {
    ...process.env,
    XDG_RUNTIME_DIR: join(root, "run"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CONFIG_HOME: join(root, "config"),
  };
  const infoPath = join(env.XDG_RUNTIME_DIR, "r3", "worker.json");
  const children: ReturnType<typeof Bun.spawn>[] = [];
  function spawn(args: string[]) {
    const child = Bun.spawn([process.execPath, ...args], {
      env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    children.push(child);
    return child;
  }
  return {
    root,
    infoPath,
    spawn,
    cli: (...args: string[]) => spawn([join(import.meta.dir, "index.ts"), ...args]),
    async cleanup() {
      for (const child of children) child.kill("SIGKILL");
      await Promise.all(children.map((child) => child.exited));
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function until(condition: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 4000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error("Worker lifecycle did not reach expected state");
    await Bun.sleep(20);
  }
}

for (const announced of [false, true]) {
  test(`worker stop clears a lock naming an unrelated live PID (announced: ${announced})`, async () => {
    const fixture = await workerFixture();
    // The substring is deliberate: only the exact worker command may be signaled.
    const unrelated = fixture.spawn(["-e", "setInterval(() => {}, 1000)", "not-__worker"]);
    try {
      writePrivateJson(`${fixture.infoPath}.lock`, unrelated.pid);
      if (announced)
        writePrivateJson(fixture.infoPath, {
          pid: unrelated.pid,
          socket: join(fixture.root, "missing.sock"),
          token: "fixture-token",
        });
      const stop = fixture.cli("worker", "stop");
      expect(await stop.exited).toBe(0);
      expect(unrelated.exitCode).toBeNull();
      expect(await Bun.file(`${fixture.infoPath}.lock`).exists()).toBe(false);
      expect(await Bun.file(fixture.infoPath).exists()).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  });
}

for (const announced of [false, true]) {
  test(`worker stop recovers an unreachable live worker (announced: ${announced})`, async () => {
    const fixture = await workerFixture();
    const worker = fixture.cli("__worker");
    try {
      await until(() => Bun.file(fixture.infoPath).exists());
      const info = await Bun.file(fixture.infoPath).json();
      await rm(info.socket);
      if (!announced) await rm(fixture.infoPath);
      const stop = fixture.cli("worker", "stop");
      expect(await stop.exited).toBe(0);
      expect(await Bun.file(`${fixture.infoPath}.lock`).exists()).toBe(false);
      await until(() => worker.exitCode !== null);
      const replacement = fixture.cli("__worker");
      await until(() => Bun.file(fixture.infoPath).exists());
      expect((await Bun.file(fixture.infoPath).json()).pid).toBe(replacement.pid);
    } finally {
      await fixture.cleanup();
    }
  });
}

test("worker stop uses authenticated IPC when the announced PID belongs to another process", async () => {
  const fixture = await workerFixture();
  const worker = fixture.cli("__worker");
  const unrelated = fixture.spawn(["-e", "setInterval(() => {}, 1000)"]);
  try {
    await until(() => Bun.file(fixture.infoPath).exists());
    const info = await Bun.file(fixture.infoPath).json();
    writePrivateJson(fixture.infoPath, { ...info, pid: unrelated.pid });
    await writeFile(`${fixture.infoPath}.lock`, String(unrelated.pid));
    const stop = fixture.cli("worker", "stop");
    expect(await stop.exited).toBe(0);
    expect(unrelated.exitCode).toBeNull();
    await until(() => worker.exitCode !== null);
    expect(await Bun.file(`${fixture.infoPath}.lock`).exists()).toBe(false);
  } finally {
    await fixture.cleanup();
  }
});

test("worker stop terminates a wedged worker before releasing its lock", async () => {
  const fixture = await workerFixture();
  const worker = fixture.cli("__worker");
  try {
    await until(() => Bun.file(fixture.infoPath).exists());
    const info = await Bun.file(fixture.infoPath).json();
    await rm(info.socket);
    worker.kill("SIGSTOP");
    const stop = fixture.cli("worker", "stop");
    expect(await stop.exited).toBe(0);
    await worker.exited;
    expect(worker.signalCode).toBe("SIGKILL");
    expect(await Bun.file(`${fixture.infoPath}.lock`).exists()).toBe(false);
    expect(await Bun.file(fixture.infoPath).exists()).toBe(false);
  } finally {
    await fixture.cleanup();
  }
}, 10_000);

test("an older reachable worker with an unidentifiable PID retains its records", async () => {
  const fixture = await workerFixture();
  const unrelated = fixture.spawn(["-e", "setInterval(() => {}, 1000)"]);
  const socket = join(fixture.root, "legacy.sock");
  const token = crypto.randomUUID();
  const server = Bun.serve({
    unix: socket,
    fetch(request) {
      if (request.headers.get("x-r3-token") !== token) return new Response(null, { status: 403 });
      return new URL(request.url).pathname === "/api/local/status"
        ? Response.json({ workerId: "legacy-worker" })
        : new Response(null, { status: 404 });
    },
  });
  try {
    writePrivateJson(fixture.infoPath, { pid: unrelated.pid, socket, token });
    writePrivateJson(`${fixture.infoPath}.lock`, unrelated.pid);
    const stop = fixture.cli("worker", "stop");
    expect(await stop.exited).toBe(1);
    expect(await new Response(stop.stderr).text()).toContain(
      "stop it from its original environment",
    );
    expect(unrelated.exitCode).toBeNull();
    expect((await Bun.file(fixture.infoPath).json()).token).toBe(token);
    expect(await Bun.file(`${fixture.infoPath}.lock`).json()).toBe(unrelated.pid);
  } finally {
    await server.stop(true);
    await fixture.cleanup();
  }
});
