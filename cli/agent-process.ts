import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { basename } from "node:path";
import type { ListenerTarget } from "../shared/types.ts";

// PID numbers are meaningful only in their original boot and PID namespace.
// startedAt distinguishes an agent from an unrelated process reusing its PID.
export interface AgentProcess {
  pid: number;
  platform: "linux" | "darwin";
  bootId: string;
  namespace: string;
  startedAt: string;
}
export type ProcessLiveness = "alive" | "dead" | "unknown";
export interface ProcessEntry {
  pid: number;
  parentPid: number;
  uid: number;
  name: string;
  startedAt: string;
  dead: boolean;
}

export function parseAgentProcess(value: unknown): AgentProcess | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Record<string, unknown>;
  if (
    !Number.isSafeInteger(input.pid) ||
    (input.pid as number) < 1 ||
    (input.pid as number) > 2147483647 ||
    (input.platform !== "linux" && input.platform !== "darwin")
  )
    return null;
  for (const key of ["bootId", "namespace", "startedAt"] as const) {
    const item = input[key];
    if (typeof item !== "string" || !item.trim() || item.length > 128 || /[\0\r\n]/.test(item))
      return null;
  }
  return {
    pid: input.pid as number,
    platform: input.platform,
    bootId: input.bootId as string,
    namespace: input.namespace as string,
    startedAt: input.startedAt as string,
  };
}

export function parseLinuxProcess(stat: string, uid: number): ProcessEntry | undefined {
  // comm may itself contain spaces and parentheses. Field 22 is starttime.
  const end = stat.lastIndexOf(")");
  const begin = stat.indexOf("(");
  const fields = stat
    .slice(end + 2)
    .trim()
    .split(/\s+/);
  const pid = Number(stat.slice(0, begin).trim());
  const parentPid = Number(fields[1]);
  if (
    begin < 1 ||
    end < begin ||
    fields.length < 20 ||
    !/^\d+$/.test(fields[19]!) ||
    !Number.isSafeInteger(pid) ||
    pid < 1 ||
    !Number.isSafeInteger(parentPid) ||
    parentPid < 0
  )
    return;
  return {
    pid,
    parentPid,
    uid,
    name: stat.slice(begin + 1, end),
    startedAt: fields[19]!,
    dead: ["Z", "X", "x"].includes(fields[0]!),
  };
}

function command(argv: string[]): string | undefined {
  try {
    const result = Bun.spawnSync(argv, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      timeout: 1000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
    });
    return result.exitCode === 0 ? result.stdout.toString().trim() : undefined;
  } catch {
    return;
  }
}

// One inspection shares its process snapshot/cache across a cleanup batch.
export class AgentProcesses {
  private readonly entries = new Map<number, ProcessEntry | null | undefined>();
  private readonly context: Omit<AgentProcess, "pid" | "startedAt"> | undefined;
  private macSnapshot = false;
  constructor() {
    try {
      if (process.platform === "linux") {
        // A host-mounted /proc inside a child namespace uses different PID
        // numbers. Preserve state when that view cannot identify our own PID.
        const self = readFileSync("/proc/self/stat", "utf8");
        if (Number(self.slice(0, self.indexOf("(")).trim()) !== process.pid) return;
        this.context = {
          platform: "linux",
          bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
          namespace: readlinkSync("/proc/self/ns/pid"),
        };
      } else if (process.platform === "darwin") {
        const bootId = command(["sysctl", "-n", "kern.boottime"]);
        if (bootId) this.context = { platform: "darwin", bootId, namespace: "host" };
      }
    } catch {
      /* An inaccessible process domain cannot establish death. */
    }
  }
  read(pid: number): ProcessEntry | null | undefined {
    if (this.entries.has(pid)) return this.entries.get(pid);
    if (this.context?.platform === "linux") {
      let entry: ProcessEntry | null | undefined;
      try {
        entry = parseLinuxProcess(
          readFileSync(`/proc/${pid}/stat`, "utf8"),
          statSync(`/proc/${pid}`).uid,
        );
      } catch {
        // A hidden /proc entry or EPERM is not proof that the process exited.
        try {
          process.kill(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") entry = null;
        }
      }
      this.entries.set(pid, entry);
      return entry;
    }
    if (this.context?.platform === "darwin") {
      if (!this.macSnapshot) {
        const output = command(["ps", "-axo", "pid=,ppid=,uid=,stat=,lstart=,comm="]);
        if (output === undefined) return;
        for (const line of output.split("\n")) {
          const match =
            /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w+\s+\w+\s+\d+\s+\d+:\d+:\d+\s+\d+)\s+(.+)$/.exec(
              line,
            );
          if (!match) return;
          const id = Number(match[1]);
          this.entries.set(id, {
            pid: id,
            parentPid: Number(match[2]),
            uid: Number(match[3]),
            dead: match[4]!.startsWith("Z"),
            startedAt: match[5]!,
            name: basename(match[6]!),
          });
        }
        this.macSnapshot = true;
      }
      return this.entries.get(pid) ?? null;
    }
    return;
  }
  identity(pid: number): AgentProcess | undefined {
    const entry = this.read(pid);
    if (!this.context || !entry || entry.dead || entry.uid !== process.getuid?.()) return;
    return { ...this.context, pid, startedAt: entry.startedAt };
  }
  liveness(owner: AgentProcess): ProcessLiveness {
    if (!this.context || this.context.platform !== owner.platform) return "unknown";
    if (this.context.bootId !== owner.bootId) return "dead";
    if (this.context.namespace !== owner.namespace) return "unknown";
    const entry = this.read(owner.pid);
    if (entry === undefined) return "unknown";
    if (!entry || entry.dead || entry.startedAt !== owner.startedAt) return "dead";
    return "alive";
  }
  localIdentity(owner: AgentProcess): AgentProcess {
    if (
      !this.context ||
      this.context.platform !== owner.platform ||
      this.context.bootId !== owner.bootId ||
      this.context.namespace === owner.namespace
    )
      return owner;
    // A CLI inside a PID namespace may talk to a worker outside it. Translate
    // only a visible same-owner process with matching namespace, PID and start.
    try {
      for (const name of readdirSync("/proc")) {
        if (!/^\d+$/.test(name)) continue;
        try {
          if (readlinkSync(`/proc/${name}/ns/pid`) !== owner.namespace) continue;
          const ids = /^NSpid:\s+(.+)$/m
            .exec(readFileSync(`/proc/${name}/status`, "utf8"))?.[1]
            ?.trim()
            .split(/\s+/);
          if (ids?.at(-1) !== String(owner.pid)) continue;
          const identity = this.identity(Number(name));
          if (identity?.startedAt === owner.startedAt) return identity;
        } catch {
          /* Other users' or exiting processes are not candidates. */
        }
      }
    } catch {
      /* Keep the original domain when translation cannot be verified. */
    }
    return owner;
  }
}

export function findAgentAncestor(
  target: ListenerTarget,
  read: (pid: number) => ProcessEntry | null | undefined,
  firstPid: number,
): number | undefined {
  const names =
    target.harness === "claude"
      ? ["claude", ".claude-wrapped"]
      : target.harness === "codex"
        ? ["codex", ".codex-wrapped"]
        : ["agy", ".agy-wrapped", "antigravity"];
  if (target.harness !== "claude" && target.executable) names.push(basename(target.executable));
  const seen = new Set<number>();
  let pid = firstPid;
  while (pid > 0 && seen.size < 64 && !seen.has(pid)) {
    seen.add(pid);
    const entry = read(pid);
    if (!entry || entry.dead) return;
    if (names.includes(basename(entry.name))) return pid;
    pid = entry.parentPid;
  }
  return;
}

export function captureAgentProcess(
  target: ListenerTarget,
  env = process.env,
): AgentProcess | undefined {
  const processes = new AgentProcesses();
  const supplied = env.R3_AGENT_PID?.trim();
  if (supplied) {
    const pid = /^\d+$/.test(supplied) ? Number(supplied) : NaN;
    const identity =
      Number.isSafeInteger(pid) && pid >= 1 && pid <= 2147483647
        ? processes.identity(pid)
        : undefined;
    if (!identity) throw new Error("R3_AGENT_PID must identify a live process owned by this user");
    return identity;
  }
  const pid = findAgentAncestor(target, (id) => processes.read(id), process.ppid);
  return pid === undefined ? undefined : processes.identity(pid);
}
