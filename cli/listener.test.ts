import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { BackendCredentials } from "./backend.ts";

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
      sessionId: "claude:claude-session",
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
      sessionId: "codex:codex-thread",
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
  ).toBe("claude:claude");
  expect(currentHarnessSession({ CODEX_SESSION_ID: "codex" })).toBe("codex:codex");
});

test("listen reports a missing publisher wake adapter before remote registration", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-listener-cli-"));
  let registered = false;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/api/health")
        return Response.json({ ok: true, version: "test", protocol: "artifacts-v2" });
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
    XDG_STATE_HOME: join(root, "state"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    XDG_CONFIG_HOME: join(root, "config"),
    R3_AGENT_SESSION: "publisher-test",
    CODEX_THREAD_ID: "codex-thread",
  };
  delete env.CLAUDE_CODE_MESSAGING_SOCKET;
  delete env.CLAUDE_CODE_MESSAGING_TOKEN;
  delete env.CLAUDE_CODE_SESSION_ID;
  await new BackendCredentials(join(root, "config", "r3", "credentials")).save({
    url: server.url.toString(),
    kind: "key",
    accessToken: env.R3_TOKEN!,
  });
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
    await rm(root, { recursive: true, force: true });
  }
});

test("identical harness-local IDs have distinct attribution without changing delivery targets", () => {
  const claude = detectListener({
    CLAUDE_CODE_SESSION_ID: "same-run",
    CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/session.sock",
    CLAUDE_CODE_MESSAGING_TOKEN: "secret",
  });
  const codex = detectListener({ CODEX_THREAD_ID: "same-run" });
  expect(claude.ok && claude.sessionId).toBe("claude:same-run");
  expect(codex.ok && codex.sessionId).toBe("codex:same-run");
  expect(codex.ok && codex.target).toEqual({ harness: "codex", threadId: "same-run" });
});
