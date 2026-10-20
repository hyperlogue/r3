import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { R3_VERSION } from "../shared/version.ts";
import { BackendCredentials } from "./backend.ts";

import { currentHarnessSession, detectListener } from "./listener.ts";
import { writePrivateJson } from "./private-state.ts";

describe("detectListener", () => {
  test("captures Antigravity connection and attribution together, ahead of inherited Codex IDs", () => {
    const sourceMetadata = JSON.stringify({ runCommand: { cascadeId: "agy-run" } });
    expect(
      detectListener({
        ANTIGRAVITY_CONVERSATION_ID: "agy-run",
        ANTIGRAVITY_LS_ADDRESS: "localhost:43210",
        ANTIGRAVITY_CSRF_TOKEN: "fixture-token",
        ANTIGRAVITY_AGENTAPI_EXE: "/tmp/fixture/agy",
        ANTIGRAVITY_SOURCE_METADATA: sourceMetadata,
        CODEX_THREAD_ID: "parent-run",
      }),
    ).toEqual({
      ok: true,
      sessionId: "antigravity:agy-run",
      target: {
        harness: "antigravity",
        conversationId: "agy-run",
        address: "localhost:43210",
        token: "fixture-token",
        executable: "/tmp/fixture/agy",
        sourceMetadata,
      },
    });
  });

  test("an incomplete Antigravity connection still supplies identity, but cannot listen", () => {
    for (const env of [
      { ANTIGRAVITY_CONVERSATION_ID: "agy-run" },
      { ANTIGRAVITY_LS_ADDRESS: "localhost:43210", ANTIGRAVITY_CSRF_TOKEN: "fixture-token" },
    ]) {
      expect(detectListener(env)).toEqual({ ok: false, reason: "missing-antigravity-connection" });
    }
    expect(currentHarnessSession({ ANTIGRAVITY_CONVERSATION_ID: "agy-run" })).toBe(
      "antigravity:agy-run",
    );
    expect(
      detectListener({ ANTIGRAVITY_CONVERSATION_ID: "agy-run", CODEX_THREAD_ID: "codex-run" }),
    ).toEqual({
      ok: true,
      target: { harness: "codex", threadId: "codex-run" },
      sessionId: "codex:codex-run",
    });
  });

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

for (const harness of ["codex", "antigravity"] as const) {
  test(`listen reports a missing ${harness} adapter before remote registration`, async () => {
    const root = await mkdtemp(join(tmpdir(), "r3-listener-cli-"));
    let registered = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/health")
          return Response.json({ ok: true, version: R3_VERSION, protocol: "artifacts-v3" });
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
      CODEX_THREAD_ID: harness === "codex" ? "codex-thread" : "",
      CODEX_SESSION_ID: "",
      ANTIGRAVITY_CONVERSATION_ID: harness === "antigravity" ? "agy-run" : "",
      ANTIGRAVITY_LS_ADDRESS: harness === "antigravity" ? "localhost:43210" : "",
      ANTIGRAVITY_CSRF_TOKEN: harness === "antigravity" ? "fixture-token" : "",
      ANTIGRAVITY_AGENTAPI_EXE: "",
      ANTIGRAVITY_SOURCE_METADATA: "",
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
      expect(stderr).toContain(
        harness === "codex"
          ? "publisher cannot run codex queue"
          : "publisher cannot run agy agentapi",
      );
      expect(registered).toBe(false);
    } finally {
      server.stop(true);
      await rm(root, { recursive: true, force: true });
    }
  });
}

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

test("Antigravity listen captures its executable privately and registers only opaque backend routing", async () => {
  const root = await mkdtemp(join(tmpdir(), "r3-agy-listen-"));
  const executable = join(root, "agent executable");
  await Bun.write(
    executable,
    `#!${process.execPath}
process.exit(JSON.stringify(process.argv.slice(2)) === JSON.stringify(["agentapi", "send-message", "--help"]) ? 0 : 1);
`,
  );
  await chmod(executable, 0o700);
  const remoteBodies: { path: string; body: Record<string, unknown> }[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/api/health")
        return Response.json({ ok: true, version: R3_VERSION, protocol: "artifacts-v3" });
      remoteBodies.push({ path, body: (await request.json()) as Record<string, unknown> });
      return Response.json({ ok: true });
    },
  });
  const localBodies: Record<string, unknown>[] = [];
  const workerToken = randomBytes(32).toString("base64url");
  const socket = join(root, "worker.sock");
  const worker = Bun.serve({
    unix: socket,
    async fetch(request) {
      if (request.headers.get("x-r3-token") !== workerToken)
        return new Response(null, { status: 403 });
      if (new URL(request.url).pathname === "/api/local/status") return Response.json({});
      localBodies.push((await request.json()) as Record<string, unknown>);
      return Response.json({ listenerId: "opaque-listener", connectionId: "opaque-connection" });
    },
  });
  const environment = {
    ...process.env,
    XDG_STATE_HOME: join(root, "state"),
    XDG_RUNTIME_DIR: join(root, "runtime"),
    XDG_CONFIG_HOME: join(root, "config"),
    R3_URL: server.url.toString(),
    R3_AGENT_SESSION: "",
    R3_AGENT_PID: String(process.pid),
    CLAUDE_CODE_MESSAGING_SOCKET: "",
    CLAUDE_CODE_MESSAGING_TOKEN: "",
    CLAUDE_CODE_SESSION_ID: "",
    CODEX_THREAD_ID: "inherited-codex",
    ANTIGRAVITY_CONVERSATION_ID: "agy-conversation",
    ANTIGRAVITY_LS_ADDRESS: "localhost:43210",
    ANTIGRAVITY_CSRF_TOKEN: "private-agy-token",
    ANTIGRAVITY_AGENTAPI_EXE: executable,
    ANTIGRAVITY_SOURCE_METADATA: '{"runCommand":{"cascadeId":"agy-conversation"}}',
  };
  try {
    await chmod(socket, 0o600);
    writePrivateJson(join(environment.XDG_RUNTIME_DIR, "r3", "worker.json"), {
      pid: process.pid,
      socket,
      token: workerToken,
    });
    await new BackendCredentials(join(root, "config", "r3", "credentials")).save({
      url: server.url.toString(),
      kind: "key",
      accessToken: randomBytes(32).toString("base64url"),
    });
    const run = async () => {
      const child = Bun.spawn(
        [process.execPath, join(import.meta.dir, "index.ts"), "listen", "artifact_test"],
        {
          cwd: root,
          env: environment,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
          killSignal: "SIGKILL",
        },
      );
      const [code, output, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { code, output, error };
    };
    expect(await run()).toEqual({ code: 0, output: "Listening on artifact_test\n", error: "" });
    expect(localBodies).toHaveLength(1);
    expect(localBodies[0].agentProcess).toMatchObject({
      pid: process.pid,
      platform: process.platform,
    });
    expect(JSON.stringify(remoteBodies)).not.toContain("agentProcess");
    expect(localBodies[0].target).toEqual({
      harness: "antigravity",
      conversationId: "agy-conversation",
      executable,
      address: environment.ANTIGRAVITY_LS_ADDRESS,
      token: environment.ANTIGRAVITY_CSRF_TOKEN,
      sourceMetadata: environment.ANTIGRAVITY_SOURCE_METADATA,
    });
    expect(remoteBodies).toContainEqual({
      path: "/api/sessions",
      body: { id: "antigravity:agy-conversation", harness: "antigravity" },
    });
    expect(remoteBodies.find((item) => item.path.endsWith("/targets"))?.body).toEqual({
      actor: { role: "agent", sessionId: "antigravity:agy-conversation" },
      listenerId: "opaque-listener",
    });
    for (const value of [
      executable,
      environment.ANTIGRAVITY_LS_ADDRESS,
      environment.ANTIGRAVITY_CSRF_TOKEN,
    ])
      expect(JSON.stringify(remoteBodies)).not.toContain(value);
    environment.R3_AGENT_PID = "2147483647";
    const staleOwner = await run();
    expect(staleOwner.code).toBe(5);
    expect(staleOwner.error).toContain("R3_AGENT_PID must identify a live process");
    expect(localBodies).toHaveLength(1);
    environment.R3_AGENT_PID = String(process.pid);
    await Bun.write(executable, `#!${process.execPath}\nprocess.exit(1);\n`);
    const failed = await run();
    expect(failed.code).toBe(5);
    expect(failed.error).toContain("cannot run agy agentapi send-message");
    expect(localBodies).toHaveLength(1);
  } finally {
    await worker.stop(true);
    await server.stop(true);
    await rm(root, { recursive: true, force: true });
  }
});
