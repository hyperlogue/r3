import { expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateJson } from "./private-state.ts";

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
