import { afterEach, beforeEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publisherGit } from "./capture-git.ts";
import { detectPublisherRemote } from "./publisher-remote.ts";

let root: string;
async function git(...args: string[]) {
  const result = await publisherGit(root, args);
  expect(result.code).toBe(0);
  return result.stdout.toString().trim();
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-publisher-remote-"));
  await git("init", "-b", "main");
});
afterEach(async () => rm(root, { recursive: true, force: true }));

test("origin wins over upstream and push URLs; detected URLs contain no credentials", async () => {
  const credential = randomBytes(24).toString("hex");
  await git(
    "remote",
    "add",
    "origin",
    `https://${credential}@code.example/team/repo.git?access=${credential}`,
  );
  await git("remote", "set-url", "--push", "origin", "https://code.example/push/repo");
  await git("remote", "add", "upstream", "https://code.example/upstream/repo");
  await git("config", "branch.main.remote", "upstream");
  const result = await detectPublisherRemote(root);
  expect(result.remote?.url).toBe("https://code.example/team/repo.git");
  expect(JSON.stringify(result)).not.toContain(credential);
});

test("upstream then sole remote are deterministic; ambiguity and local remotes omit inference", async () => {
  expect((await detectPublisherRemote(root)).remote).toBeNull();
  await git("remote", "add", "first", "https://code.example/first/repo");
  expect((await detectPublisherRemote(root)).remote?.key).toBe("code.example/first/repo");
  await git("remote", "add", "second", "https://code.example/second/repo");
  expect((await detectPublisherRemote(root)).warning).toContain("multiple Git remotes");
  await git("config", "branch.main.remote", "second");
  expect((await detectPublisherRemote(root)).remote?.key).toBe("code.example/second/repo");
  await git("remote", "add", "origin", "/path/to/local/repo");
  const local = await detectPublisherRemote(root);
  expect(local.remote).toBeNull();
  expect(local.warning).not.toContain("/path/to/local/repo");
});

test("multiple fetch URLs are rejected and Git URL rewriting is normalized before transmission", async () => {
  await git("remote", "add", "origin", "https://code.example/one/repo");
  await git("remote", "set-url", "--add", "origin", "https://code.example/two/repo");
  expect((await detectPublisherRemote(root)).warning).toContain("unique fetch URL");
  await git("remote", "remove", "origin");
  await git("config", "url.https://code.example/.insteadOf", "shortcut:");
  await git("remote", "add", "origin", "shortcut:team/repo");
  expect((await detectPublisherRemote(root)).remote?.key).toBe("code.example/team/repo");
});
