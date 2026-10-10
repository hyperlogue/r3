import { dirname, join } from "node:path";
import { daemonJsonPath, isPidAlive } from "../server/config.ts";
import { ArtifactClient } from "../shared/artifact-client.ts";
import { ArtifactCommandError } from "./artifact-args.ts";
import { cliProcessArgv } from "./daemon-client.ts";
import { readPrivateJson } from "./private-state.ts";
import type { WorkerInfo } from "./worker-runtime.ts";

const path = () => join(dirname(daemonJsonPath()), "worker.json");

export function workerSandboxWarning(env: NodeJS.ProcessEnv): string | null {
  // Environment markers are advisory: they can outlive an approved sandbox escape,
  // and an unrecognized sandbox may expose none. Session identity alone is not evidence.
  const profile = env.CODEX_PERMISSION_PROFILE;
  if (
    !env.CODEX_SANDBOX?.trim() &&
    env.CODEX_SANDBOX_NETWORK_DISABLED !== "1" &&
    profile !== "read-only" &&
    profile !== "workspace-write"
  )
    return null;
  return [
    "Warning: sandbox environment detected while starting the r3 worker.",
    "The worker inherits this CLI's permissions; detaching does not escape the sandbox.",
    "Agent notifications may fail even if this command succeeds.",
    "If this CLI is sandboxed, run `r3 worker restart` from a terminal outside the sandbox.",
  ].join("\n");
}

export async function existingWorker(): Promise<ArtifactClient | null> {
  const info = readPrivateJson<WorkerInfo>(path());
  if (!info) return null;
  // Authenticated IPC works across PID namespaces; a saved PID is not liveness.
  const client = new ArtifactClient({
    url: "http://localhost",
    token: info.token,
    fetch: (request) => fetch(request, { unix: info.socket }),
  });
  try {
    await client.json("GET", "/api/local/status", undefined, AbortSignal.timeout(1000));
    return client;
  } catch {
    return null;
  }
}
export async function ensureWorker(): Promise<ArtifactClient> {
  const current = await existingWorker();
  if (current) {
    await current.json("POST", "/api/local/import", {});
    return current;
  }
  const warning = workerSandboxWarning(process.env);
  if (warning) console.error(warning);
  const child = Bun.spawn(cliProcessArgv("__worker"), {
    env: { ...process.env, R3_DETACHED: "1" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  child.unref();
  for (let count = 0; count < 200; count++) {
    const client = await existingWorker();
    if (client) return client;
    if (child.exitCode !== null) break;
    await Bun.sleep(50);
  }
  throw new ArtifactCommandError("Worker did not start; run r3 __worker to inspect startup", 5);
}
export async function reloadWorker(url: string): Promise<void> {
  const worker = await existingWorker();
  if (worker) await worker.json("POST", "/api/local/reload", { url });
}
export async function workerCommand(command: string): Promise<void> {
  if (command === "restart") {
    await workerCommand("stop");
    await workerCommand("start");
    return;
  }
  if (command === "start") {
    await ensureWorker();
    console.log("r3 worker is running");
    return;
  }
  const worker = await existingWorker();
  if (command === "status") {
    console.log(
      worker
        ? JSON.stringify(await worker.json("GET", "/api/local/status"), null, 2)
        : "r3 worker is stopped",
    );
    return;
  }
  if (command !== "stop") throw new ArtifactCommandError("worker start|stop|status|restart");
  const info = readPrivateJson<WorkerInfo>(path());
  if (!worker || !info) {
    console.log("r3 worker is stopped");
    return;
  }
  const processName = Bun.spawnSync(["ps", "-p", String(info.pid), "-o", "command="], {
    stdout: "pipe",
    stderr: "ignore",
  }).stdout.toString();
  if (!processName.includes("__worker"))
    throw new Error("Worker process identity changed; refusing to signal it");
  process.kill(info.pid, "SIGTERM");
  for (let count = 0; count < 100 && isPidAlive(info.pid); count++) await Bun.sleep(50);
  if (isPidAlive(info.pid)) throw new Error("Worker is still stopping");
  console.log("r3 worker stopped");
}
