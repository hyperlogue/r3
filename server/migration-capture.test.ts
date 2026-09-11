import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publisherGit } from "../cli/capture-git.ts";
import { legacyLocalCapture } from "./migration-capture.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-migration-capture-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const capture = () =>
  legacyLocalCapture({ scratchRoot: join(root, "scratch"), docsRoot: join(root, "docs") });

describe("one-time legacy local capture", () => {
  test("scratch directories retain their paths and include nested binary resources", async () => {
    await mkdir(join(root, "scratch/review_scratch/assets"), { recursive: true });
    await writeFile(
      join(root, "scratch/review_scratch/index.md"),
      "![Resource](./assets/image.bin)",
    );
    await writeFile(
      join(root, "scratch/review_scratch/assets/image.bin"),
      Buffer.from([0, 255, 42]),
    );
    const result = await capture()(
      { id: "review_scratch", kind: "files", source: '{"ref":"SCRATCH","files":[]}' },
      null,
    );
    if (!("files" in result)) throw new Error("Scratch capture failed");
    expect(result.files.map((file) => file.path)).toEqual([
      "review_scratch/assets/image.bin",
      "review_scratch/index.md",
    ]);
    expect(Buffer.from(result.files[0].base64, "base64")).toEqual(Buffer.from([0, 255, 42]));
  });

  test("a removed worktree is unavailable even when the primary contains the same filename", async () => {
    await publisherGit(root, ["init", "--quiet"]);
    await writeFile(join(root, "notes.txt"), "Primary content");
    const source = JSON.stringify({ ref: "WORKING", files: ["notes.txt"] });
    const repo = { common_dir: join(root, ".git") };
    const missing = await capture()(
      { id: "review_linked", kind: "files", source, worktree: '{"name":"removed"}' },
      repo,
    );
    expect(missing).toEqual({ unavailable: "The original worktree is no longer available" });
    const primary = await capture()({ id: "review_primary", kind: "files", source }, repo);
    if (!("files" in primary)) throw new Error("Primary capture failed");
    expect(Buffer.from(primary.files[0].base64, "base64").toString()).toBe("Primary content");
  });

  test("pinned git and old document sources capture without a live worktree mapping", async () => {
    await publisherGit(root, ["init", "--quiet"]);
    await writeFile(join(root, "notes.txt"), "Pinned content");
    await publisherGit(root, ["add", "--", "notes.txt"]);
    const tree = (await publisherGit(root, ["write-tree"])).stdout.toString().trim();
    await rm(join(root, "notes.txt"));
    const pinned = await capture()(
      {
        id: "review_pinned",
        kind: "files",
        source: JSON.stringify({ ref: tree, files: ["notes.txt"] }),
        worktree: '{"name":"removed"}',
      },
      { common_dir: join(root, ".git") },
    );
    if (!("files" in pinned)) throw new Error("Pinned capture failed");
    expect(Buffer.from(pinned.files[0].base64, "base64").toString()).toBe("Pinned content");
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs/review_doc.md"), "# Retained document");
    expect(
      await capture()({ id: "review_doc", kind: "doc", source: '{"doc":"review_doc.md"}' }, null),
    ).toMatchObject({ kind: "files", files: [{ path: "review_doc.md" }] });
  });
});
