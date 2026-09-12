import { describe, expect, test } from "bun:test";

import {
  listenerTransportAvailable,
  parseListenerTarget,
  probeListener,
  pushToCodexQueue,
} from "./listener.ts";

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
