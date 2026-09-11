import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureFiles } from "./capture.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-capture-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("publisher directory capture", () => {
  test("captures a complete nested directory with binary and empty members", async () => {
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), "<img src='./assets/data.bin'>");
    await writeFile(join(root, "assets/data.bin"), Buffer.from([0, 255, 128]));
    await writeFile(join(root, "assets/empty.txt"), "");
    const files = await captureFiles(root);
    expect(files.map((file) => file.path)).toEqual([
      "assets/data.bin",
      "assets/empty.txt",
      "index.html",
    ]);
    expect(Buffer.from(files[0].base64, "base64")).toEqual(Buffer.from([0, 255, 128]));
    expect(files[1].base64).toBe("");
    expect(files[2].mediaType).toStartWith("text/html");
    await rm(join(root, "assets/data.bin"));
    expect(Buffer.from(files[0].base64, "base64")).toEqual(Buffer.from([0, 255, 128]));
  });

  test("selected paths define complete membership without unrelated files or duplicates", async () => {
    await mkdir(join(root, "docs"));
    await writeFile(join(root, "docs/design.md"), "# Design");
    await writeFile(join(root, "unrelated.txt"), "Unselected");
    const files = await captureFiles(root, ["docs", "docs/design.md"]);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("docs/design.md");
    expect(files[0].mediaType).toStartWith("text/markdown");
    await expect(captureFiles(root, ["missing.txt"])).rejects.toThrow();
    await expect(captureFiles(root, ["../outside"])).rejects.toThrow();
  });

  test("rejects symlinks and empty directories instead of changing membership silently", async () => {
    await expect(captureFiles(root)).rejects.toThrow("at least one file");
    await writeFile(join(root, "real.txt"), "Real bytes");
    await symlink("real.txt", join(root, "link.txt"));
    await expect(captureFiles(root)).rejects.toThrow("symbolic link");
    await expect(captureFiles(root, ["link.txt"])).rejects.toThrow("symbolic link");
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested/inside.txt"), "Inside");
    await symlink("nested", join(root, "alias"));
    await expect(captureFiles(root, ["alias/inside.txt"])).rejects.toThrow("symbolic link");
  });

  test("rejects a capture while a producer is still writing its input", async () => {
    for (let i = 0; i < 80; i++) await writeFile(join(root, `file-${i}.txt`), "Initial");
    let running = true;
    let writes = 0;
    const producer = (async () => {
      while (running) {
        await writeFile(join(root, "file-0.txt"), `Revision ${++writes}`);
        await Bun.sleep(1);
      }
    })();
    try {
      await expect(captureFiles(root)).rejects.toThrow("changed during capture");
      expect(writes).toBeGreaterThan(1);
    } finally {
      running = false;
      await producer;
    }
  });
});
