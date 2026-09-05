// Harness-specific delivery behind the one `r3 listen` abstraction.
//
// Claude Code accepts an authenticated write to a per-session Unix socket (see
// inbox.ts). Codex CLI 0.149+ exposes `codex queue`, which addresses a persisted
// thread and wakes it when idle. Keep the dispatch here so the review routes and
// the one-slot presence registry do not need harness-specific branches.

import type { CodexListenerTarget, ListenerTarget } from "../shared/types.ts";
import { probeInbox, pushToInbox, validateSocketPath } from "./inbox.ts";
import type { ListenerLiveness } from "./watchers.ts";

const CODEX_QUEUE_TIMEOUT_MS = 10_000;
const MAX_THREAD_ID_CHARS = 200;

export type ParsedListenerTarget =
  | { ok: true; target: ListenerTarget }
  | { ok: false; error: string };

// Parse at the HTTP boundary instead of trusting the TypeScript union: older r3
// clients omit `harness` on their Claude-shaped request, and arbitrary callers
// can still send malformed JSON.
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
    return { ok: true, target: { harness: "codex", threadId } };
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

export type CodexCommandRunner = (argv: string[]) => Promise<number>;

const runCodexCommand: CodexCommandRunner = async (argv) => {
  const proc = Bun.spawn(argv, {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    timeout: CODEX_QUEUE_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  return proc.exited;
};

// Registration checks capability in the daemon process that will perform the
// later delivery. It uses the same bounded runner as the queue operation, so a
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
  const code = await run(["codex", "queue", "--thread", target.threadId, "--message", text]);
  if (code !== 0) throw new Error(`codex queue exited ${code}`);
}

export async function pushToListener(target: ListenerTarget, text: string): Promise<void> {
  if (target.harness === "claude") return pushToInbox(target, text);
  return pushToCodexQueue(target, text);
}

// What either harness reads. The id and timestamp keep repeated Claude pushes
// distinct; both transports use the same compact instruction and terminal note.
export function nudgeText(
  reviewId: string,
  title: string,
  event: "submitted" | "approved" | "abandoned",
  opts: { now?: Date; note?: string | null } = {},
): string {
  const now = opts.now ?? new Date();
  const headline =
    event === "submitted"
      ? "feedback submitted"
      : event === "approved"
        ? "approved — the loop is done"
        : "abandoned — closed without approval";
  const at = now.toISOString().replace(/\.\d+Z$/, "Z");
  const lines = [`[r3] ${reviewId} — ${headline} at ${at}`, `Review: ${title}`];
  if (event === "submitted") lines.push(`Run: r3 prompt ${reviewId}`);

  // Approval is the final push, so its note must ride the nudge; the full text
  // remains in meta.next_steps when this compact copy is truncated.
  const note = capNote(opts.note ?? "");
  if (note.text) {
    lines.push("", "Next steps from the human:", note.text);
    if (note.truncated) lines.push(`(truncated — see \`r3 show ${reviewId}\` for the full note)`);
  }
  return lines.join("\n");
}

export const MAX_NOTE_CHARS = 400;

export function capNote(note: string): { text: string; truncated: boolean } {
  const t = note.trim();
  if (t.length <= MAX_NOTE_CHARS) return { text: t, truncated: false };
  const cut = t.slice(0, MAX_NOTE_CHARS);
  const sp = cut.search(/\s\S*$/);
  // Honour a word boundary unless it discards most of the budget (a long run
  // without whitespace is one token and has no useful boundary).
  const kept = sp > MAX_NOTE_CHARS * 0.6 ? cut.slice(0, sp) : cut;
  return { text: `${kept.trimEnd()}…`, truncated: true };
}
