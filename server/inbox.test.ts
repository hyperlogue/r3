import { describe, expect, test } from "bun:test";

// Pure guards: no db.ts, so no R3_DB dance.
import { validateSocketPath } from "./inbox.ts";

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
