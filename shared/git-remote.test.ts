import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { normalizeGitRemote } from "./git-remote.ts";

test("repository identities join common transports without collapsing path case or custom ports", () => {
  const key = "code.example/Team/project";
  for (const value of [
    "https://CODE.example/Team/project.git",
    "ssh://git@code.example:22/Team/project.git",
    "git@code.example:Team/project",
    "http://code.example:80/Team/project/",
  ])
    expect(normalizeGitRemote(value)?.key).toBe(key);
  expect(normalizeGitRemote("https://code.example/team/project")?.key).not.toBe(key);
  expect(normalizeGitRemote("ssh://code.example:2222/Team/project")?.key).not.toBe(key);
});

test("remote metadata strips credentials and excludes filesystem and helper inputs", () => {
  const credential = randomBytes(24).toString("hex");
  const remote = normalizeGitRemote(
    `https://${credential}:${credential}@code.example/team/project.git?access=${credential}#${credential}`,
  );
  expect(remote?.url).toBe("https://code.example/team/project.git");
  expect(JSON.stringify(remote)).not.toContain(credential);
  for (const value of [
    "",
    "/path/to/repo",
    "../repo",
    "file:///path/to/repo",
    "C:/repo",
    "C:\\repo",
    "ext::command",
    "ssh://code.example",
    "https://code.example/",
    "code.example:~/repo",
    "https://code.example/repo\nextra",
  ])
    expect(normalizeGitRemote(value)).toBeNull();
});
