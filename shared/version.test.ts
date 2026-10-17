import { expect, test } from "bun:test";
import { compareVersions } from "./version.ts";

test("release versions order numeric components and SemVer prereleases", () => {
  const ordered = [
    "2.9.9",
    "2.10.0-alpha",
    "2.10.0-alpha.1",
    "2.10.0-alpha.beta",
    "2.10.0-beta",
    "2.10.0-beta.2",
    "2.10.0-beta.11",
    "2.10.0-rc.1",
    "2.10.0",
    "2.10.1",
    "3.0.0",
    "9007199254740992.0.0",
    "9007199254740993.0.0",
  ];
  for (let index = 1; index < ordered.length; index++) {
    expect(compareVersions(ordered[index - 1], ordered[index])).toBe(-1);
    expect(compareVersions(ordered[index], ordered[index - 1])).toBe(1);
  }
  expect(compareVersions("2.2.0+build.1", "2.2.0+build.2")).toBe(0);
  expect(compareVersions("2.2.0-rc.1+build", "2.2.0-rc.1")).toBe(0);
});

test("unknown or malformed releases are not guessed into an upgrade direction", () => {
  for (const invalid of [
    "",
    "test",
    "v2.2.0",
    "2.2",
    "02.2.0",
    "2.2.0-01",
    "2.2.0-",
    "2.2.0+",
    "2.2.0\n",
    "1".repeat(129),
  ]) {
    expect(compareVersions(invalid, "2.2.0")).toBeNull();
    expect(compareVersions("2.2.0", invalid)).toBeNull();
  }
});
