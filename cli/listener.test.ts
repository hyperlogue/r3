import { describe, expect, test } from "bun:test";
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

test("listen maps daemon-side missing queue support to exit 5", async () => {
  let registered: unknown;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/reviews/review_test")
        return Response.json({ status: "open", meta: {} });
      if (request.method === "POST" && url.pathname === "/api/reviews/review_test/listen") {
        registered = await request.json();
        return new Response("Codex queue unavailable", { status: 501 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const env: Record<string, string | undefined> = {
    ...process.env,
    R3_URL: server.url.toString().replace(/\/$/, ""),
    R3_TOKEN: "test-token",
    CODEX_THREAD_ID: "codex-thread",
  };
  delete env.CLAUDE_CODE_MESSAGING_SOCKET;
  delete env.CLAUDE_CODE_MESSAGING_TOKEN;
  delete env.CLAUDE_CODE_SESSION_ID;
  try {
    const proc = Bun.spawn([process.execPath, "cli/index.ts", "listen", "review_test"], {
      cwd: resolve(import.meta.dir, ".."),
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      timeout: 5_000,
      killSignal: "SIGKILL",
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    expect(code).toBe(5);
    expect(stderr).toContain("the daemon cannot run `codex queue`");
    expect(registered).toMatchObject({
      harness: "codex",
      threadId: "codex-thread",
      session: "codex-thread",
    });
  } finally {
    server.stop(true);
  }
});
