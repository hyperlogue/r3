// Pure harness detection for `r3 listen`.
//
// Select the delivery target and its default display identity together. A
// partially inherited Claude environment can coexist with a valid Codex one;
// keeping this decision atomic prevents a Codex target from wearing Claude's
// session id and failing same-client slot reclamation.

import type { ListenerTarget } from "../shared/types.ts";

type Environment = Record<string, string | undefined>;

const value = (env: Environment, name: string): string | undefined =>
  env[name]?.trim() || undefined;

const codexThreadId = (env: Environment): string | undefined =>
  value(env, "CODEX_THREAD_ID") ?? value(env, "CODEX_SESSION_ID");

export function currentHarnessSession(env: Environment = process.env): string | undefined {
  return value(env, "CLAUDE_CODE_SESSION_ID") ?? codexThreadId(env);
}

export type ListenerDetection =
  | { ok: true; target: ListenerTarget; sessionId?: string }
  | { ok: false; reason: "missing-claude-token" | "unsupported" };

export function detectListener(env: Environment = process.env): ListenerDetection {
  const socket = value(env, "CLAUDE_CODE_MESSAGING_SOCKET");
  const token = value(env, "CLAUDE_CODE_MESSAGING_TOKEN");
  if (socket && token) {
    return {
      ok: true,
      target: { harness: "claude", socket, token },
      sessionId: value(env, "CLAUDE_CODE_SESSION_ID"),
    };
  }

  const threadId = codexThreadId(env);
  if (threadId)
    return {
      ok: true,
      target: { harness: "codex", threadId },
      sessionId: threadId,
    };

  return { ok: false, reason: socket ? "missing-claude-token" : "unsupported" };
}
