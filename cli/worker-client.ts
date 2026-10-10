import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { daemonJsonPath, isPidAlive } from "../server/config.ts";
import { ArtifactApiError, ArtifactClient } from "../shared/artifact-client.ts";
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

export async function existingWorker(
  info = readPrivateJson<WorkerInfo>(path()),
): Promise<ArtifactClient | null> {
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

function workerProcess(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  const result = Bun.spawnSync(["ps", "-ww", "-p", String(pid), "-o", "uid=,stat=,command="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const match = result.stdout.toString().match(/^\s*(\d+)\s+(\S+)\s+([\s\S]*)$/);
  if (result.exitCode !== 0 || !match) {
    if (!isPidAlive(pid)) return false;
    throw new Error("Cannot inspect worker process identity; refusing to signal it");
  }
  return (
    (!process.getuid || Number(match[1]) === process.getuid()) &&
    !match[2].startsWith("Z") &&
    match[3].trim().split(/\s+/).includes("__worker")
  );
}

async function stopWorkerProcess(pid: number): Promise<boolean> {
  if (!workerProcess(pid)) return false;
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    try {
      process.kill(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
    for (let count = 0; count < (signal === "SIGTERM" ? 60 : 40); count++) {
      if (!workerProcess(pid)) return true;
      await Bun.sleep(50);
    }
  }
  throw new Error("Worker is still stopping; its start lock was retained");
}

async function stopWorker(): Promise<void> {
  const info = readPrivateJson<WorkerInfo>(path());
  const lockPath = `${path()}.lock`;
  const owner = readPrivateJson<number>(lockPath);
  const worker = await existingWorker(info);
  if (worker && info) {
    try {
      // The recorded PID may name an unrelated process outside the worker's namespace.
      await worker.json("POST", "/api/local/stop", {}, AbortSignal.timeout(1000));
      for (let count = 0; count < 100; count++) {
        if (readPrivateJson<WorkerInfo>(path())?.token !== info.token) {
          console.log("r3 worker stopped");
          return;
        }
        await Bun.sleep(50);
      }
      throw new Error("Worker is still stopping; its start lock was retained");
    } catch (error) {
      if (!(error instanceof ArtifactApiError) || error.status !== 404) throw error;
      // Older workers have no shutdown endpoint. Only signal a verified local PID.
      if (!workerProcess(info.pid))
        throw new Error(
          "This worker predates IPC shutdown and its process cannot be identified here; stop it from its original environment",
        );
    }
  }
  let stopped = false;
  for (const pid of new Set([owner, info?.pid])) {
    if (pid !== null && pid !== undefined) stopped = (await stopWorkerProcess(pid)) || stopped;
  }
  // An unreachable socket does not establish that the lock owner is gone. Clear
  // only the records inspected above, after verified workers have actually exited.
  if (owner !== null && readPrivateJson<number>(lockPath) === owner)
    rmSync(lockPath, { force: true });
  if (info && readPrivateJson<WorkerInfo>(path())?.token === info.token)
    rmSync(path(), { force: true });
  console.log(stopped ? "r3 worker stopped" : "r3 worker is stopped");
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
  if (command === "stop") return stopWorker();
  const worker = await existingWorker();
  if (command === "status") {
    console.log(
      worker
        ? JSON.stringify(await worker.json("GET", "/api/local/status"), null, 2)
        : "r3 worker is stopped",
    );
    return;
  }
  throw new ArtifactCommandError("worker start|stop|status|restart");
}
