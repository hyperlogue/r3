import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { ArtifactError, requireActor, requireString } from "../server/artifact-validation.ts";
import { parseListenerTarget } from "../server/listener.ts";
import type { ArtifactActor } from "../shared/artifacts.ts";
import { normalizeBackendUrl } from "../shared/backend-url.ts";
import type { ListenerTarget } from "../shared/types.ts";
import { WORKER_DESTINATION_LIMIT } from "../shared/worker-protocol.ts";
import {
  type AgentProcess,
  AgentProcesses,
  type ProcessLiveness,
  parseAgentProcess,
} from "./agent-process.ts";
import {
  cleanupPrivateTemps,
  privateDirectory,
  readPrivateJson,
  removePrivateJson,
  writePrivateJson,
} from "./private-state.ts";

export interface WorkerTarget {
  version: 1;
  id: string;
  url: string;
  actor: ArtifactActor;
  target: ListenerTarget;
  agentProcess?: AgentProcess;
  updatedAt: number;
}
interface WorkerState {
  version: 3;
  workerId: string;
}
interface ProcessCheck {
  liveness(owner: AgentProcess): ProcessLiveness;
  localIdentity(owner: AgentProcess): AgentProcess;
}
interface Options {
  now?: () => number;
  processes?: () => ProcessCheck;
}
const TARGET_NAME = /^[a-f0-9]{64}\.json$/;
export const PROCESS_SWEEP_INTERVAL_MS = 60_000;

function record(value: unknown): WorkerTarget {
  if (!value || typeof value !== "object") throw new Error("Invalid worker destination");
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || !Number.isFinite(item.updatedAt))
    throw new Error("Invalid worker destination");
  const actor = requireActor(item.actor);
  if (actor.role !== "agent") throw new Error("Invalid worker destination actor");
  // A saved Claude socket can be absent temporarily. Delivery checks its owner
  // and socket type; loading state must not equate an absent socket with expiry.
  const target = parseListenerTarget(item.target, () => null);
  if (!target.ok) throw new Error("Invalid worker destination target");
  const agentProcess =
    item.agentProcess === undefined ? undefined : parseAgentProcess(item.agentProcess);
  if (agentProcess === null) throw new Error("Invalid worker destination process");
  return {
    version: 1,
    id: requireString(item.id, "destination id", 200),
    url: normalizeBackendUrl(requireString(item.url, "backend URL", 4096)),
    actor,
    target: target.target,
    ...(agentProcess ? { agentProcess } : {}),
    updatedAt: item.updatedAt as number,
  };
}

// The notification worker is the only writer. Each atomic destination file is
// authoritative; there is no second persisted index to reconcile after a crash.
export class WorkerTargets {
  readonly workerId: string;
  readonly directory: string;
  private readonly targets = new Map<string, WorkerTarget>();
  private lastSweep = -Infinity;
  private latestUpdate = 0;
  private readonly now: () => number;
  private readonly processes: () => ProcessCheck;
  constructor(path: string, options: Options = {}) {
    this.now = options.now ?? Date.now;
    this.processes = options.processes ?? (() => new AgentProcesses());
    this.directory = join(dirname(path), "worker-targets");
    privateDirectory(dirname(path));
    privateDirectory(this.directory);
    cleanupPrivateTemps(dirname(path), (name) => name === basename(path));
    cleanupPrivateTemps(this.directory, (name) => TARGET_NAME.test(name));
    const saved = readPrivateJson<
      WorkerState | { version: number; workerId: string; targets: unknown[] }
    >(path);
    if (
      saved &&
      (![1, 2, 3].includes(saved.version) || typeof saved.workerId !== "string" || !saved.workerId)
    )
      throw new Error("Unsupported worker state format");
    this.workerId = saved?.workerId ?? randomUUID();
    if (saved && saved.version !== 3) {
      if (!("targets" in saved) || !Array.isArray(saved.targets))
        throw new Error("Unsupported worker state format");
      // Validate everything first. Write all files durably before replacing the
      // aggregate, so an interrupted migration can replay from its original data.
      const migrated = saved.targets.map((item, index) =>
        record({
          ...(item as object),
          version: 1,
          updatedAt: this.now() + index,
        }),
      );
      for (const target of migrated) writePrivateJson(this.file(target.url, target.id), target);
    }
    if (saved?.version !== 3) writePrivateJson(path, { version: 3, workerId: this.workerId });
    for (const name of readdirSync(this.directory)) {
      if (!TARGET_NAME.test(name)) continue;
      const path = join(this.directory, name);
      const stat = lstatSync(path);
      // Never follow a foreign/symlink entry, even inside the private directory.
      if (!stat.isFile() || stat.mode & 0o077 || (process.getuid && stat.uid !== process.getuid()))
        continue;
      try {
        const target = record(readPrivateJson(path));
        if (this.file(target.url, target.id) !== path)
          throw new Error("Mismatched destination file");
        this.targets.set(this.key(target.url, target.id), target);
        this.latestUpdate = Math.max(this.latestUpdate, target.updatedAt);
      } catch {
        // A corrupt owned record cannot deliver; isolate its failure from other
        // sessions and remove the unusable credential copy.
        removePrivateJson(path);
      }
    }
    rmSync(join(dirname(path), "worker-import.json"), { force: true });
    this.sweep();
  }
  private key(url: string, id: string): string {
    return createHash("sha256")
      .update(JSON.stringify([url, id]))
      .digest("hex");
  }
  private file(url: string, id: string): string {
    return join(this.directory, `${this.key(url, id)}.json`);
  }
  list(): WorkerTarget[] {
    return [...this.targets.values()].sort((a, b) => a.updatedAt - b.updatedAt);
  }
  get(url: string, id: string): WorkerTarget | undefined {
    return this.targets.get(this.key(url, id));
  }
  private remove(target: WorkerTarget): void {
    removePrivateJson(this.file(target.url, target.id));
    this.targets.delete(this.key(target.url, target.id));
  }
  private save(target: WorkerTarget): void {
    target.updatedAt = this.latestUpdate = Math.max(this.now(), this.latestUpdate + 1);
    writePrivateJson(this.file(target.url, target.id), target);
    this.targets.set(this.key(target.url, target.id), target);
  }
  bind(
    url: string,
    actor: ArtifactActor,
    target: ListenerTarget,
    agentProcess?: AgentProcess,
  ): WorkerTarget {
    this.sweep();
    const processes = this.processes();
    const owner = agentProcess ? processes.localIdentity(agentProcess) : undefined;
    if (owner && processes.liveness(owner) === "dead")
      throw new ArtifactError(
        "Agent process has exited; listen from the current agent session",
        409,
      );
    const existing = this.list().find(
      (value) => value.url === url && value.actor.sessionId === actor.sessionId,
    );
    const saved: WorkerTarget = {
      version: 1,
      id: existing?.id ?? randomUUID(),
      url,
      actor,
      target,
      ...(owner ? { agentProcess: owner } : {}),
      updatedAt: 0,
    };
    this.save(saved);
    return saved;
  }
  touch(url: string, id: string): void {
    const target = this.get(url, id);
    if (target) this.save({ ...target });
  }
  forDelivery(url: string, id: string): WorkerTarget | undefined {
    const target = this.get(url, id);
    if (target?.agentProcess && this.processes().liveness(target.agentProcess) === "dead") {
      this.remove(target);
      return;
    }
    return target;
  }
  sweep(): void {
    const now = this.now();
    if (now >= this.lastSweep && now - this.lastSweep < PROCESS_SWEEP_INTERVAL_MS) return;
    this.lastSweep = now;
    const processes = this.processes();
    for (const target of this.targets.values()) {
      if (target.agentProcess && processes.liveness(target.agentProcess) === "dead")
        this.remove(target);
    }
  }
  prune(url: string, retained: Set<string>): void {
    let unused = 0;
    for (const target of this.list().toReversed()) {
      if (target.url !== url || retained.has(target.id)) continue;
      if (++unused > WORKER_DESTINATION_LIMIT) this.remove(target);
    }
  }
}
