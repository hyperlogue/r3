import { describe, expect, test } from "bun:test";

import {
  capNote,
  listenerTransportAvailable,
  MAX_NOTE_CHARS,
  nudgeText,
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
  test("checks queue capability through the daemon's bounded command seam", async () => {
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

describe("nudgeText", () => {
  const t0 = new Date("2026-09-02T15:42:07.123Z");

  test("leads with the review id, so two reviews never send identical text", () => {
    const a = nudgeText("review_aaa", "Same title", "submitted", { now: t0 });
    const b = nudgeText("review_bbb", "Same title", "submitted", { now: t0 });
    expect(a).not.toBe(b);
    expect(a.split("\n")[0]).toBe("[r3] review_aaa — feedback submitted at 2026-09-02T15:42:07Z");
  });

  test("two Submits on the same review differ, so neither is deduplicated", () => {
    const first = nudgeText("review_aaa", "T", "submitted", { now: t0 });
    const second = nudgeText("review_aaa", "T", "submitted", {
      now: new Date(t0.getTime() + 1000),
    });
    expect(first).not.toBe(second);
  });

  test("only a submitted review has feedback to fetch", () => {
    expect(nudgeText("review_a", "T", "submitted", { now: t0 })).toContain(
      "Run: r3 prompt review_a",
    );
    expect(nudgeText("review_a", "T", "approved", { now: t0 })).not.toContain("Run:");
    expect(nudgeText("review_a", "T", "abandoned", { now: t0 })).not.toContain("Run:");
  });

  test("names terminal outcomes and carries an approval note", () => {
    const approved = nudgeText("review_a", "T", "approved", {
      now: t0,
      note: "Rebase onto main.",
    });
    expect(approved).toContain("approved");
    expect(approved).toContain("Next steps from the human:");
    expect(approved).toContain("Rebase onto main.");
    expect(nudgeText("review_a", "T", "abandoned", { now: t0 })).toContain("abandoned");
  });

  test("omits an empty note and points at a truncated note's full text", () => {
    for (const note of [undefined, null, "", "   "]) {
      expect(nudgeText("review_a", "T", "approved", { now: t0, note })).not.toContain("Next steps");
    }
    const text = nudgeText("review_a", "T", "approved", {
      now: t0,
      note: `${"word ".repeat(200)}end`,
    });
    expect(text).toContain("r3 show review_a");
    expect(text).not.toContain("end");
  });
});

describe("capNote", () => {
  test("passes a note that fits through untouched", () => {
    expect(capNote("  Rebase onto main.  ")).toEqual({
      text: "Rebase onto main.",
      truncated: false,
    });
  });

  test("cuts at a word boundary, staying within the cap", () => {
    const { text, truncated } = capNote(`${"word ".repeat(200)}tail`);
    expect(truncated).toBe(true);
    expect(text.length).toBeLessThanOrEqual(MAX_NOTE_CHARS + 1);
    expect(text.endsWith("word…")).toBe(true);
  });

  test("cuts a whitespace-free token instead of discarding most of the budget", () => {
    const { text } = capNote(`short ${"x".repeat(600)}`);
    expect(text.length).toBe(MAX_NOTE_CHARS + 1);
  });
});
