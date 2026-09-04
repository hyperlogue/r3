import { describe, expect, test } from "bun:test";

// Pure guards + text: no db.ts, so no R3_DB dance.
import { capNote, MAX_NOTE_CHARS, nudgeText, validateSocketPath } from "./inbox.ts";

// The shape rules run before any filesystem access, so they are checkable
// against paths that don't exist. The stat-backed rules (is a socket, our uid)
// need a real socket and are left to the daemon.
describe("validateSocketPath rejects anything outside the harness namespace", () => {
  const bad: [string, string][] = [
    ["", "missing"],
    ["run/user/1000/cc-socks/1.sock", "absolute"],
    ["/run/user/1000/cc-socks/1.sock\0/etc/passwd", "null byte"],
    ["/run/user/1000/cc-socks/1", ".sock"],
    ["/tmp/evil/1.sock", "outside"],
    ["/run/user/1000/cc-socks/nested/1.sock", "outside"],
    ["/home/someone/.r3/1.sock", "outside"],
    ["/run/user/abc/cc-socks/1.sock", "outside"],
  ];
  for (const [p, why] of bad) {
    test(`rejects ${JSON.stringify(p)}`, () => {
      const err = validateSocketPath(p);
      expect(err).not.toBeNull();
      expect(err).toMatch(new RegExp(why, "i"));
    });
  }

  // These are the shapes we must NOT reject: they get past the pure rules and on
  // to the filesystem checks, which is where a non-existent path then fails.
  test("accepts the documented directories' shape, failing only on existence", () => {
    for (const p of [
      "/run/user/1000/cc-socks/12345.sock",
      "/tmp/cc-socks/12345.sock",
      "/tmp/cc-socks-501/12345.sock",
      "/private/tmp/cc-socks-501/12345.sock",
      "/data/data/com.termux/files/usr/tmp/cc-socks/1.sock",
    ]) {
      expect(validateSocketPath(p)).toBe("socket does not exist");
    }
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

  // The case that actually loses a round: same review, two Submits close
  // together. Identical text would be deduped by the harness and the second
  // round would sit unsent with nothing to report it.
  test("two Submits on the SAME review differ, so neither can be deduped away", () => {
    const first = nudgeText("review_aaa", "T", "submitted", { now: t0 });
    const second = nudgeText("review_aaa", "T", "submitted", {
      now: new Date(t0.getTime() + 1000),
    });
    expect(first).not.toBe(second);
  });

  test("tells the agent what to run, but only when there is something to fetch", () => {
    expect(nudgeText("review_a", "T", "submitted", { now: t0 })).toContain(
      "Run: r3 prompt review_a",
    );
    expect(nudgeText("review_a", "T", "approved", { now: t0 })).not.toContain("Run:");
    expect(nudgeText("review_a", "T", "abandoned", { now: t0 })).not.toContain("Run:");
  });

  test("names the terminal outcome, since there is no exit code to carry it", () => {
    expect(nudgeText("review_a", "T", "approved", { now: t0 })).toContain("approved");
    expect(nudgeText("review_a", "T", "abandoned", { now: t0 })).toContain("abandoned");
  });

  // A listener's nudge is terminal: the registration is dropped right after it,
  // so anything the approval said has to be IN this message or it is lost.
  test("carries the approval's next-steps note, which nothing else will deliver", () => {
    const text = nudgeText("review_a", "T", "approved", { now: t0, note: "Rebase onto main." });
    expect(text).toContain("Next steps from the human:");
    expect(text).toContain("Rebase onto main.");
  });

  test("omits the note block when there is no note", () => {
    for (const note of [undefined, null, "", "   "]) {
      expect(nudgeText("review_a", "T", "approved", { now: t0, note })).not.toContain("Next steps");
    }
  });

  test("points at the full note when it had to cut one short", () => {
    const long = `${"word ".repeat(200)}end`;
    const text = nudgeText("review_a", "T", "approved", { now: t0, note: long });
    expect(text).toContain("r3 show review_a");
    expect(text).not.toContain("end");
    expect(nudgeText("review_a", "T", "approved", { now: t0, note: "short" })).not.toContain(
      "truncated",
    );
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
    expect(text.length).toBeLessThanOrEqual(MAX_NOTE_CHARS + 1); // + the ellipsis
    expect(text.endsWith("word…")).toBe(true);
  });

  // One 400-character token has no boundary worth honouring — cutting at the
  // last space would throw away most of the budget, so cut mid-token instead.
  test("cuts mid-token rather than lose most of the budget", () => {
    const { text } = capNote(`short ${"x".repeat(600)}`);
    expect(text.length).toBe(MAX_NOTE_CHARS + 1);
  });
});
