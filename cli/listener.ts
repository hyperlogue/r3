// Pure harness detection for publication and `r3 listen`.
//
// Select the delivery target and its default session identity together. A
// partially inherited Claude environment can coexist with a valid Codex one;
// keeping this decision atomic prevents a Codex target from wearing Claude's
// session id. A separate CLI display label never changes the delivery target.

import type { ListenerTarget } from "../shared/types.ts";

type Environment = Record<string, string | undefined>;

const value = (env: Environment, name: string): string | undefined =>
  env[name]?.trim() || undefined;

const codexThreadId = (env: Environment): string | undefined =>
  value(env, "CODEX_THREAD_ID") ?? value(env, "CODEX_SESSION_ID");

export function currentHarnessSession(env: Environment = process.env): string | undefined {
  const claude = value(env, "CLAUDE_CODE_SESSION_ID");
  if (claude) return `claude:${claude}`;
  const antigravity = value(env, "ANTIGRAVITY_CONVERSATION_ID");
  if (antigravity) return `antigravity:${antigravity}`;
  const codex = codexThreadId(env);
  return codex ? `codex:${codex}` : undefined;
}

export type ListenerDetection =
  | { ok: true; target: ListenerTarget; sessionId?: string }
  | {
      ok: false;
      reason: "missing-claude-token" | "missing-antigravity-connection" | "unsupported";
    };

export function detectListener(env: Environment = process.env): ListenerDetection {
  const socket = value(env, "CLAUDE_CODE_MESSAGING_SOCKET");
  const token = value(env, "CLAUDE_CODE_MESSAGING_TOKEN");
  if (socket && token) {
    return {
      ok: true,
      target: { harness: "claude", socket, token },
      sessionId: value(env, "CLAUDE_CODE_SESSION_ID")
        ? `claude:${value(env, "CLAUDE_CODE_SESSION_ID")}`
        : undefined,
    };
  }

  const conversationId = value(env, "ANTIGRAVITY_CONVERSATION_ID");
  const address = value(env, "ANTIGRAVITY_LS_ADDRESS");
  const csrfToken = value(env, "ANTIGRAVITY_CSRF_TOKEN");
  if (conversationId && address && csrfToken) {
    const executable = value(env, "ANTIGRAVITY_AGENTAPI_EXE");
    const sourceMetadata = value(env, "ANTIGRAVITY_SOURCE_METADATA");
    return {
      ok: true,
      target: {
        harness: "antigravity",
        conversationId,
        address,
        token: csrfToken,
        ...(executable ? { executable } : {}),
        ...(sourceMetadata ? { sourceMetadata } : {}),
      },
      sessionId: `antigravity:${conversationId}`,
    };
  }

  const threadId = codexThreadId(env);
  if (threadId)
    return {
      ok: true,
      target: { harness: "codex", threadId },
      sessionId: `codex:${threadId}`,
    };

  return {
    ok: false,
    reason: socket
      ? "missing-claude-token"
      : conversationId || address || csrfToken
        ? "missing-antigravity-connection"
        : "unsupported",
  };
}
