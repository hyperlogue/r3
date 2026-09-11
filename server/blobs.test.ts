import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobStore, hashBytes } from "./blobs.ts";

let root: string;
let store: BlobStore;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "r3-blobs-"));
  store = new BlobStore(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("immutable byte storage", () => {
  test("binary and empty files survive reopening without text conversion", async () => {
    const bytes = Buffer.from([0, 0xff, 0x80, 0x0d, 0x0a, 0, 0x42]);
    const binary = await store.put(bytes);
    const empty = await store.put(Buffer.alloc(0));
    const reopened = new BlobStore(root);
    expect(binary.byteLength).toBe(bytes.length);
    expect(await reopened.read(binary.hash)).toEqual(bytes);
    expect(await reopened.read(empty.hash)).toEqual(Buffer.alloc(0));
    expect(empty.byteLength).toBe(0);
  });

  test("concurrent identical uploads install one complete blob and remove temporary files", async () => {
    const bytes = Buffer.alloc(512 * 1024, 0xc3);
    const uploads = await Promise.all(Array.from({ length: 8 }, () => store.put(bytes)));
    expect(new Set(uploads.map((blob) => blob.hash)).size).toBe(1);
    const hash = uploads[0].hash;
    expect(await store.read(hash)).toEqual(bytes);
    expect(await readdir(join(root, hash.slice(0, 2)))).toEqual([hash.slice(2)]);
  });

  test("publication owns its input before asynchronous writes begin", async () => {
    const input = Buffer.from("published");
    const pending = store.put(input);
    input.fill(0);
    const stored = await pending;
    expect((await store.read(stored.hash)).toString()).toBe("published");
  });

  test("corruption and substituted symlinks fail closed instead of changing published bytes", async () => {
    const blob = await store.put("original");
    const path = join(root, blob.hash.slice(0, 2), blob.hash.slice(2));
    await writeFile(path, "corrupted");
    await expect(store.read(blob.hash)).rejects.toThrow("digest");
    await expect(store.put("original")).rejects.toThrow("digest");
    await unlink(path);
    const outside = join(root, "unrelated");
    await writeFile(outside, "original");
    await symlink(outside, path);
    await expect(store.read(blob.hash)).rejects.toThrow();
    await expect(store.put("original")).rejects.toThrow();
    await expect(store.read("../unrelated")).rejects.toThrow("Invalid blob hash");
    expect(hashBytes("original")).toBe(blob.hash);
  });
});
