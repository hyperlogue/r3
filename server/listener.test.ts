import { describe, expect, test } from "bun:test";
import type { AntigravityListenerTarget } from "../shared/types.ts";
import {
  listenerTransportAvailable,
  parseListenerTarget,
  probeListener,
  pushToAntigravity,
  pushToCodexQueue,
} from "./listener.ts";
import { deliverLocalAgent } from "./local-agents.ts";

const antigravity: AntigravityListenerTarget = {
  harness: "antigravity",
  conversationId: "fixture-conversation",
  address: "localhost:43210",
  token: "private-fixture-token",
  executable: "/tmp/fixture/agy",
  sourceMetadata: '{"runCommand":{"cascadeId":"fixture-conversation"}}',
};

describe("Antigravity listener transport", () => {
  test("validates local connection details without exposing them in errors", () => {
    for (const address of ["localhost:43210", "127.0.0.1:1", "[::1]:65535"])
      expect(parseListenerTarget({ ...antigravity, address })).toEqual({
        ok: true,
        target: { ...antigravity, address },
      });
    for (const address of [
      "example.com:1234",
      "192.0.2.1:1234",
      "0.0.0.0:1234",
      "[::]:1234",
      "localhost:0",
      "localhost:65536",
      "localhost:1/path",
      "localhost:1\n",
      "http://localhost:1234",
      "dns:///localhost:1234",
      "localhost:1234@evil.example",
    ]) {
      const result = parseListenerTarget({ ...antigravity, address });
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain(antigravity.token);
    }
    for (const change of [
      { conversationId: "" },
      { conversationId: "a\0b" },
      { conversationId: "a".repeat(201) },
      { token: " " },
      { token: "a\0b" },
      { token: "a\r\nb" },
      { token: "a".repeat(4097) },
      { executable: "relative/agy" },
      { executable: "/tmp/a\0b" },
      { sourceMetadata: "not json" },
      { sourceMetadata: "null" },
      { sourceMetadata: "[]" },
      { sourceMetadata: JSON.stringify({ value: "a".repeat(8192) }) },
    ])
      expect(parseListenerTarget({ ...antigravity, ...change }).ok).toBe(false);
  });

  test("checks the captured executable's hidden send command without sending a message", async () => {
    const calls: string[][] = [];
    expect(
      await listenerTransportAvailable(antigravity, async (argv) => {
        calls.push(argv);
        return 0;
      }),
    ).toBe(true);
    expect(calls).toEqual([[antigravity.executable!, "agentapi", "send-message", "--help"]]);
    expect(await listenerTransportAvailable(antigravity, async () => 1)).toBe(false);
    expect(
      await listenerTransportAvailable(antigravity, async () => {
        throw new Error("missing");
      }),
    ).toBe(false);
  });

  test("keeps message text inert and restores the registering session's private environment", async () => {
    let argv: string[] = [];
    let environment: Record<string, string | undefined> | undefined;
    const text = "review $(do-not-run) `nor-this`\nsecond line";
    await pushToAntigravity(
      { ...antigravity, conversationId: "--not-a-flag" },
      text,
      async (args, env) => {
        argv = args;
        environment = env;
        return 0;
      },
    );
    expect(argv).toEqual([
      antigravity.executable!,
      "agentapi",
      "send-message",
      "--title=r3",
      "--",
      "--not-a-flag",
      text,
    ]);
    expect(environment).toMatchObject({
      ANTIGRAVITY_LS_ADDRESS: antigravity.address,
      ANTIGRAVITY_CSRF_TOKEN: antigravity.token,
      ANTIGRAVITY_CONVERSATION_ID: "--not-a-flag",
      ANTIGRAVITY_SOURCE_METADATA: antigravity.sourceMetadata,
    });
    await pushToAntigravity(
      { ...antigravity, sourceMetadata: undefined },
      text,
      async (_args, env) => {
        expect(Object.hasOwn(env!, "ANTIGRAVITY_SOURCE_METADATA")).toBe(true);
        expect(env!.ANTIGRAVITY_SOURCE_METADATA).toBeUndefined();
        return 0;
      },
    );
  });

  test("reports RPC and executable failures without leaking connection details", async () => {
    await expect(pushToAntigravity(antigravity, "nudge", async () => 1)).rejects.toThrow(
      "agentapi exited 1",
    );
    await expect(
      deliverLocalAgent({ ...antigravity, executable: "/missing-r3-test/agy" }, "nudge"),
    ).rejects.toThrow(
      "Antigravity could not queue the notification. Keep its session running and register it again.",
    );
    expect(await probeListener(antigravity)).toBe("unknown");
  });
});

describe("parseListenerTarget", () => {
  test("accepts a Codex thread id", () => {
    expect(
      parseListenerTarget({
        harness: "codex",
        session: "session-a",
        threadId: " 019c-thread ",
      }),
    ).toEqual({ ok: true, target: { harness: "codex", threadId: "019c-thread" } });
  });

  test("rejects an absent or unsafe Codex thread id", () => {
    expect(parseListenerTarget({ harness: "codex", session: "session-a", threadId: " " })).toEqual({
      ok: false,
      error: "missing Codex thread id",
    });
    expect(
      parseListenerTarget({ harness: "codex", session: "session-a", threadId: "a\0b" }),
    ).toEqual({ ok: false, error: "Codex thread id contains a null byte" });
    expect(
      parseListenerTarget({ harness: "codex", session: "session-a", threadId: "a".repeat(201) }),
    ).toEqual({ ok: false, error: "Codex thread id is too long" });
  });

  test("keeps accepting the legacy untagged Claude request", () => {
    const request = {
      session: "session-a",
      socket: "/tmp/cc-socks/missing.sock",
      token: "secret",
    };
    expect(parseListenerTarget(request, () => null)).toEqual({
      ok: true,
      target: {
        harness: "claude",
        socket: "/tmp/cc-socks/missing.sock",
        token: "secret",
      },
    });
  });
});

describe("Codex listener transport", () => {
  test("checks queue capability through the publisher's bounded command seam", async () => {
    let argv: string[] = [];
    expect(
      await listenerTransportAvailable({ harness: "codex", threadId: "thread-a" }, async (next) => {
        argv = next;
        return 0;
      }),
    ).toBe(true);
    expect(argv).toEqual(["codex", "queue", "--help"]);
    expect(
      await listenerTransportAvailable({ harness: "codex", threadId: "thread-a" }, async () => 1),
    ).toBe(false);
    expect(
      await listenerTransportAvailable({ harness: "codex", threadId: "thread-a" }, async () => {
        throw new Error("missing executable");
      }),
    ).toBe(false);
  });

  test("Claude capability does not invoke the Codex command seam", async () => {
    let invoked = false;
    expect(
      await listenerTransportAvailable(
        { harness: "claude", socket: "/tmp/cc-socks/1.sock", token: "secret" },
        async () => {
          invoked = true;
          return 1;
        },
      ),
    ).toBe(true);
    expect(invoked).toBe(false);
  });

  test("passes the thread and message as inert argv values", async () => {
    let argv: string[] = [];
    await pushToCodexQueue(
      { harness: "codex", threadId: "thread; still-one-argument" },
      "review text with $() and newlines\nleft untouched",
      async (next) => {
        argv = next;
        return 0;
      },
    );
    expect(argv).toEqual([
      "codex",
      "queue",
      "--thread",
      "thread; still-one-argument",
      "--message",
      "review text with $() and newlines\nleft untouched",
    ]);
  });

  test("treats a non-zero queue exit as failed delivery", async () => {
    expect(
      pushToCodexQueue({ harness: "codex", threadId: "thread-a" }, "nudge", async () => 1),
    ).rejects.toThrow("codex queue exited 1");
  });

  test("an idle Codex thread does not need a socket-style liveness probe", async () => {
    expect(await probeListener({ harness: "codex", threadId: "thread-a" })).toBe("unknown");
  });
});
