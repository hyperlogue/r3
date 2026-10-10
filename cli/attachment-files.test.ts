import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const operation of ["upload", "reuse"]) {
  test(`${operation} rejects a named pipe without waiting for a writer`, async () => {
    const root = await mkdtemp(join(tmpdir(), "r3-image-pipe-"));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    try {
      const id = `image_${"a".repeat(32)}`;
      const path = join(root, `${id}.png`);
      expect(await Bun.spawn(["mkfifo", path]).exited).toBe(0);
      child = Bun.spawn(
        [
          process.execPath,
          "-e",
          `const { readAttachmentFiles, downloadCommentImages } = await import("./attachment-files.ts");
           const [operation, directory, id] = process.argv.slice(1);
           try {
             if (operation === "upload") await readAttachmentFiles([id + ".png"], directory);
             else await downloadCommentImages({ request() { throw new Error("Unexpected download"); } },
               [{id, hash: "0".repeat(64), mediaType: "image/png", byteLength: 1}], directory);
             process.exit(1);
           } catch (error) {
             process.exit(/regular PNG|differs from the snapshot/.test(error.message) ? 0 : 2);
           }`,
          operation,
          root,
          id,
        ],
        { cwd: import.meta.dir, stdout: "ignore", stderr: "ignore" },
      );
      const result = await Promise.race([child.exited, Bun.sleep(1500).then(() => "hung")]);
      expect(result).toBe(0);
    } finally {
      if (child && child.exitCode === null) child.kill();
      await child?.exited;
      await rm(root, { recursive: true, force: true });
    }
  });
}
