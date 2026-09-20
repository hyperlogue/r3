// Harness-specific delivery behind the one `r3 listen` abstraction.
//
// Claude Code accepts an authenticated write to a per-session Unix socket (see
// inbox.ts). Codex CLI 0.149+ exposes `codex queue`, which addresses a persisted
// thread and wakes it when idle. These adapters run only in the publisher-side
// listener for remote transport, or in the existing local artifact daemon.

import { isAbsolute } from "node:path";
import type { CodexListenerTarget, ListenerTarget } from "../shared/types.ts";
import { probeInbox, pushToInbox, validateSocketPath } from "./inbox.ts";
export type ListenerLiveness = "alive" | "dead" | "unknown";

const CODEX_QUEUE_TIMEOUT_MS = 10_000;
const MAX_THREAD_ID_CHARS = 200;

export type ParsedListenerTarget =
  | { ok: true; target: ListenerTarget }
  | { ok: false; error: string };

// Validate locally detected harness data before using a socket or executable.
// The remote HTTP contract carries only logical agent/session identity.
export function parseListenerTarget(
  body: unknown,
  validateSocket: (path: string) => string | null = validateSocketPath,
): ParsedListenerTarget {
  const request = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (request.harness === "codex") {
    const threadId = typeof request.threadId === "string" ? request.threadId.trim() : "";
    if (!threadId) return { ok: false, error: "missing Codex thread id" };
    if (threadId.includes("\0"))
      return { ok: false, error: "Codex thread id contains a null byte" };
    if (threadId.length > MAX_THREAD_ID_CHARS)
      return { ok: false, error: "Codex thread id is too long" };
    for (const key of ["executable", "home"] as const) {
      const path = request[key];
      if (
        path !== undefined &&
        (typeof path !== "string" || !isAbsolute(path) || path.includes("\0") || path.length > 4096)
      )
        return { ok: false, error: `invalid Codex ${key}` };
    }
    return {
      ok: true,
      target: {
        harness: "codex",
        threadId,
        ...(request.executable === undefined ? {} : { executable: request.executable as string }),
        ...(request.home === undefined ? {} : { home: request.home as string }),
      },
    };
  }

  if (request.harness !== undefined && request.harness !== "claude")
    return { ok: false, error: "unsupported listener harness" };
  const socket = typeof request.socket === "string" ? request.socket : "";
  const invalid = validateSocket(socket);
  if (invalid) return { ok: false, error: `bad socket: ${invalid}` };
  // Required, not best-effort: an unattributed Claude push may be held for
  // approval without a receipt, making a registration look live but never fire.
  const token = typeof request.token === "string" ? request.token.slice(0, 4096) : "";
  if (!token) return { ok: false, error: "missing token" };
  return { ok: true, target: { harness: "claude", socket, token } };
}

export type CodexCommandRunner = (
  argv: string[],
  environment?: Record<string, string | undefined>,
) => Promise<number>;

const runCodexCommand: CodexCommandRunner = async (argv, environment) => {
  const proc = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    timeout: CODEX_QUEUE_TIMEOUT_MS,
    killSignal: "SIGKILL",
    env: environment,
  });
  return proc.exited;
};

// Registration checks capability in the publisher process that will perform
// the later delivery. It uses the same bounded runner as the queue operation, so a
// different PATH or a pre-0.149 binary cannot produce a false-successful listen.
export async function listenerTransportAvailable(
  target: ListenerTarget,
  run: CodexCommandRunner = runCodexCommand,
): Promise<boolean> {
  if (target.harness === "claude") return true;
  try {
    return (await run(["codex", "queue", "--help"])) === 0;
  } catch {
    return false;
  }
}

// Claude has a real connect probe. Codex threads remain addressable while idle,
// but queue offers no non-mutating per-thread probe; report that honestly and
// keep the registration until delivery fails or the daemon restarts.
export async function probeListener(target: ListenerTarget): Promise<ListenerLiveness> {
  if (target.harness === "codex") return "unknown";
  return (await probeInbox(target)) ? "alive" : "dead";
}

export async function pushToCodexQueue(
  target: CodexListenerTarget,
  text: string,
  run: CodexCommandRunner = runCodexCommand,
): Promise<void> {
  // Direct argv, never a shell: both the persisted thread name and human prose
  // are untrusted strings. Separate option/value arguments are consumed by the
  // CLI parser without becoming executable syntax.
  const code = await run(
    [target.executable ?? "codex", "queue", "--thread", target.threadId, "--message", text],
    target.home ? { ...process.env, CODEX_HOME: target.home } : undefined,
  );
  if (code !== 0) throw new Error(`codex queue exited ${code}`);
}

export async function pushToListener(target: ListenerTarget, text: string): Promise<void> {
  if (target.harness === "claude") return pushToInbox(target, text);
  return pushToCodexQueue(target, text);
}
