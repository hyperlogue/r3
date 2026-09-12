import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { currentHarnessSession, detectListener } from "./listener.ts";

describe("detectListener", () => {
  test("selects a complete Claude target and its matching identity", () => {
    expect(
      detectListener({
        CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/1.sock",
        CLAUDE_CODE_MESSAGING_TOKEN: "token",
        CLAUDE_CODE_SESSION_ID: "claude-session",
        CODEX_THREAD_ID: "codex-thread",
      }),
    ).toEqual({
      ok: true,
      target: {
        harness: "claude",
        socket: "/tmp/cc-socks/1.sock",
        token: "token",
      },
      sessionId: "claude-session",
    });
  });

  test("falls back atomically to Codex when the Claude target is incomplete", () => {
    expect(
      detectListener({
        CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/1.sock",
        CLAUDE_CODE_SESSION_ID: "claude-session",
        CODEX_THREAD_ID: "codex-thread",
      }),
    ).toEqual({
      ok: true,
      target: { harness: "codex", threadId: "codex-thread" },
      sessionId: "codex-thread",
    });
  });

  test("distinguishes a missing Claude token from an unsupported harness", () => {
    expect(detectListener({ CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/1.sock" })).toEqual({
      ok: false,
      reason: "missing-claude-token",
    });
    expect(detectListener({})).toEqual({ ok: false, reason: "unsupported" });
  });
});

test("currentHarnessSession retains the general Claude-then-Codex provenance rule", () => {
  expect(
    currentHarnessSession({ CLAUDE_CODE_SESSION_ID: "claude", CODEX_THREAD_ID: "codex" }),
  ).toBe("claude");
  expect(currentHarnessSession({ CODEX_SESSION_ID: "codex" })).toBe("codex");
});

test("listen reports a missing publisher wake adapter before remote registration", async () => {
  let registered = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/health")
        return Response.json({ ok: true, version: "test", protocol: "artifacts-v1" });
      if (url.pathname === "/api/sessions") return Response.json(await request.json());
      if (url.pathname.endsWith("/listen")) registered = true;
      return new Response("not found", { status: 404 });
    },
  });
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: "",
    R3_URL: server.url.toString(),
    R3_TOKEN: randomBytes(32).toString("base64url"),
    R3_AGENT_SESSION: "publisher-test",
    CODEX_THREAD_ID: "codex-thread",
  };
  delete env.CLAUDE_CODE_MESSAGING_SOCKET;
  delete env.CLAUDE_CODE_MESSAGING_TOKEN;
  delete env.CLAUDE_CODE_SESSION_ID;
  try {
    const child = Bun.spawn(
      [process.execPath, "cli/index.ts", "listen", "artifact_test", "--foreground"],
      {
        cwd: resolve(import.meta.dir, ".."),
        env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        timeout: 5000,
        killSignal: "SIGKILL",
      },
    );
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(code).toBe(5);
    expect(stderr).toContain("publisher cannot run codex queue");
    expect(registered).toBe(false);
  } finally {
    server.stop(true);
  }
});
