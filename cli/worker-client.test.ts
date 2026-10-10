import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
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
