import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateStoredPatch } from "../server/patch-content.ts";
import { captureGitDiff, captureGitFiles, publisherGit } from "./capture-git.ts";

let root: string;
let originalTree: string;
async function git(...args: string[]): Promise<string> {
  const result = await publisherGit(root, args);
  if (result.code) throw new Error(result.stderr);
  return result.stdout.toString().trim();
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-git-capture-"));
  await git("init", "--quiet");
  await writeFile(join(root, "readme.md"), "# Original\n");
  await writeFile(join(root, "data.bin"), Buffer.from([0, 255, 128, 0]));
  await git("add", "--", "readme.md", "data.bin");
  originalTree = await git("write-tree");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("publisher git capture", () => {
  test("captures immutable git blobs independently of their working files", async () => {
    await rm(join(root, "data.bin"));
    await writeFile(join(root, "readme.md"), "Changed on disk");
    const files = await captureGitFiles(root, originalTree, ["readme.md", "data.bin"]);
    expect(files.map((f) => f.path)).toEqual(["data.bin", "readme.md"]);
    expect(Buffer.from(files[0].base64, "base64")).toEqual(Buffer.from([0, 255, 128, 0]));
    expect(Buffer.from(files[1].base64, "base64").toString()).toBe("# Original\n");
    await expect(captureGitFiles(root, originalTree, ["missing.txt"])).rejects.toThrow("absent");
    await expect(captureGitFiles(root, "--output=unexpected", ["readme.md"])).rejects.toThrow(
      "Invalid git reference",
    );
  });

  test("staged files and staged patches use index content", async () => {
    await writeFile(join(root, "readme.md"), "# Staged\n");
    await git("add", "--", "readme.md");
    await writeFile(join(root, "readme.md"), "# Unstaged\n");
    const files = await captureGitFiles(root, "STAGED", ["readme.md"]);
    expect(Buffer.from(files[0].base64, "base64").toString()).toBe("# Staged\n");
    const patch = await captureGitDiff(root, originalTree, "STAGED");
    expect(patch).toContain("+# Staged");
    expect(patch).not.toContain("Unstaged");
    expect(validateStoredPatch(patch).map((file) => file.path)).toEqual(["readme.md"]);
  });

  test("working capture includes untracked and binary changes and bypasses external diff drivers", async () => {
    await git("config", "diff.external", "false");
    await writeFile(join(root, "readme.md"), "# Working\n");
    await writeFile(join(root, "data.bin"), Buffer.from([0, 255, 42, 0]));
    await writeFile(join(root, "new file.txt"), "New untracked file\n");
    const patch = await captureGitDiff(root, originalTree, "WORKING");
    const files = validateStoredPatch(patch);
    expect(files.find((file) => file.path === "new file.txt")?.status).toBe("added");
    expect(files.find((file) => file.path === "data.bin")?.binary).toBe(true);
    expect(patch).toContain("+# Working");
    expect(patch).toContain("GIT binary patch");
  });

  test("tree comparisons reject empty results and preserve captured context", async () => {
    await expect(captureGitDiff(root, originalTree, originalTree)).rejects.toThrow("no changes");
    await writeFile(join(root, "readme.md"), "# Revised\n");
    await git("add", "--", "readme.md");
    const next = await git("write-tree");
    await writeFile(join(root, "readme.md"), "Later working content");
    const patch = await captureGitDiff(root, originalTree, next);
    expect(patch).toContain("-# Original");
    expect(patch).toContain("+# Revised");
    expect(patch).not.toContain("Later working content");
  });
});
