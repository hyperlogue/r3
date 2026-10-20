// Harness-specific delivery behind the one `r3 listen` abstraction.
//
// Claude Code accepts an authenticated write to a per-session Unix socket (see
// inbox.ts). Codex CLI 0.149+ exposes `codex queue`, which addresses a persisted
// thread and wakes it when idle. Antigravity's agentapi sends to a conversation
// through its running local backend. The local notification worker runs these
// adapters for both local and remote backends.

import { isAbsolute } from "node:path";
import type {
  AntigravityListenerTarget,
  CodexListenerTarget,
  ListenerTarget,
} from "../shared/types.ts";
import { probeInbox, pushToInbox, validateSocketPath } from "./inbox.ts";
export type ListenerLiveness = "alive" | "dead" | "unknown";

const COMMAND_TIMEOUT_MS = 10_000;
const MAX_THREAD_ID_CHARS = 200;

function validExecutable(path: unknown): boolean {
  return (
    typeof path === "string" && isAbsolute(path) && !path.includes("\0") && path.length <= 4096
  );
}

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
  if (request.harness === "antigravity") {
    const conversationId =
      typeof request.conversationId === "string" ? request.conversationId.trim() : "";
    if (!conversationId || conversationId.includes("\0") || conversationId.length > 200)
      return { ok: false, error: "invalid Antigravity conversation id" };
    // agentapi uses plaintext gRPC. Keep its credentials on the local machine,
    // rejecting resolver schemes, URLs, and arbitrary hostnames before spawning.
    const address = typeof request.address === "string" ? request.address : "";
    const match = /^(?:localhost|127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})$/.exec(address);
    if (!match || match[0] !== address || Number(match[1]) > 65535)
      return { ok: false, error: "Antigravity requires a loopback host:port address" };
    const token = typeof request.token === "string" ? request.token : "";
    if (!token.trim() || token.length > 4096 || /[\0\r\n]/.test(token))
      return { ok: false, error: "invalid Antigravity messaging token" };
    if (request.executable !== undefined && !validExecutable(request.executable))
      return { ok: false, error: "invalid Antigravity executable" };
    const sourceMetadata = request.sourceMetadata;
    if (sourceMetadata !== undefined) {
      try {
        if (typeof sourceMetadata !== "string" || sourceMetadata.length > 8192) throw new Error();
        const parsed: unknown = JSON.parse(sourceMetadata);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      } catch {
        return { ok: false, error: "invalid Antigravity source metadata" };
      }
    }
    return {
      ok: true,
      target: {
        harness: "antigravity",
        conversationId,
        address,
        token,
        ...(request.executable === undefined ? {} : { executable: request.executable as string }),
        ...(sourceMetadata === undefined ? {} : { sourceMetadata: sourceMetadata as string }),
      },
    };
  }
  if (request.harness === "codex") {
    const threadId = typeof request.threadId === "string" ? request.threadId.trim() : "";
    if (!threadId) return { ok: false, error: "missing Codex thread id" };
    if (threadId.includes("\0"))
      return { ok: false, error: "Codex thread id contains a null byte" };
    if (threadId.length > MAX_THREAD_ID_CHARS)
      return { ok: false, error: "Codex thread id is too long" };
    for (const key of ["executable", "home"] as const) {
      const path = request[key];
      if (path !== undefined && !validExecutable(path))
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

export type ListenerCommandRunner = (
  argv: string[],
  environment?: Record<string, string | undefined>,
) => Promise<number>;

const runListenerCommand: ListenerCommandRunner = async (argv, environment) => {
  const proc = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    timeout: COMMAND_TIMEOUT_MS,
    killSignal: "SIGKILL",
    env: environment,
  });
  return proc.exited;
};

// Capability checks use the same bounded runner and captured executable as
// delivery. Help sends no message and does not prove that the session is running.
export async function listenerTransportAvailable(
  target: ListenerTarget,
  run: ListenerCommandRunner = runListenerCommand,
): Promise<boolean> {
  if (target.harness === "claude") return true;
  try {
    const argv =
      target.harness === "antigravity"
        ? [target.executable ?? "agy", "agentapi", "send-message", "--help"]
        : [target.executable ?? "codex", "queue", "--help"];
    return (await run(argv)) === 0;
  } catch {
    return false;
  }
}

// Only Claude supplies a socket liveness probe here. Other adapters establish
// acceptance at delivery; a conversation identity alone does not prove liveness.
export async function probeListener(target: ListenerTarget): Promise<ListenerLiveness> {
  if (target.harness !== "claude") return "unknown";
  return (await probeInbox(target)) ? "alive" : "dead";
}

export async function pushToCodexQueue(
  target: CodexListenerTarget,
  text: string,
  run: ListenerCommandRunner = runListenerCommand,
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

export async function pushToAntigravity(
  target: AntigravityListenerTarget,
  text: string,
  run: ListenerCommandRunner = runListenerCommand,
): Promise<void> {
  const code = await run(
    [
      target.executable ?? "agy",
      "agentapi",
      "send-message",
      "--title=r3",
      "--",
      target.conversationId,
      text,
    ],
    {
      ...process.env,
      ANTIGRAVITY_LS_ADDRESS: target.address,
      ANTIGRAVITY_CSRF_TOKEN: target.token,
      ANTIGRAVITY_CONVERSATION_ID: target.conversationId,
      // A worker can serve several sessions. Never inherit another caller's attribution.
      ANTIGRAVITY_SOURCE_METADATA: target.sourceMetadata,
    },
  );
  // agentapi reports RPC failures with a nonzero exit. Its stdout/stderr can
  // include private connection details and must never reach the backend.
  if (code !== 0) throw new Error(`Antigravity agentapi exited ${code}`);
}

export async function pushToListener(target: ListenerTarget, text: string): Promise<void> {
  if (target.harness === "claude") return pushToInbox(target, text);
  if (target.harness === "antigravity") return pushToAntigravity(target, text);
  return pushToCodexQueue(target, text);
}
