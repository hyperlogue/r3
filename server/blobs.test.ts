import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
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

  test("collection removes only unreferenced bytes and abandoned upload files", async () => {
    const live = await store.put("Retained content");
    const orphan = await store.put("Interrupted publication");
    const directory = join(root, live.hash.slice(0, 2));
    const temporary = join(directory, `.upload-${randomUUID()}`);
    await writeFile(temporary, "Partial upload");
    await writeFile(join(directory, "unmanaged.txt"), "Leave unrelated files alone");
    expect(await store.collect(() => new Set([live.hash]))).toBe(2);
    expect((await store.read(live.hash)).toString()).toBe("Retained content");
    await expect(store.read(orphan.hash)).rejects.toThrow();
    expect(await Bun.file(temporary).exists()).toBe(false);
    expect(await Bun.file(join(directory, "unmanaged.txt")).exists()).toBe(true);
  });

  test("collection marks after an in-flight publication commits and holds new publishers", async () => {
    const live = new Set<string>();
    let ready!: () => void;
    const prepared = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let commit!: () => void;
    const committing = new Promise<void>((resolve) => {
      commit = resolve;
    });
    const first = store.publishing(async () => {
      const file = await store.put("First publication");
      ready();
      await committing;
      live.add(file.hash);
      return file;
    });
    await prepared;
    let marked = false;
    const collection = store.collect(() => {
      marked = true;
      return new Set(live);
    });
    let secondStarted = false;
    const second = store.publishing(async () => {
      secondStarted = true;
      return store.put("Second publication");
    });
    await Promise.resolve();
    expect(marked).toBe(false);
    expect(secondStarted).toBe(false);
    commit();
    const retained = await first;
    expect(await collection).toBe(0);
    const later = await second;
    expect((await store.read(retained.hash)).toString()).toBe("First publication");
    expect((await store.read(later.hash)).toString()).toBe("Second publication");
  });

  test("failed publication and collection release their gates for retry", async () => {
    await expect(
      store.publishing(async () => {
        await store.put("Uncommitted");
        throw new Error("Commit failed");
      }),
    ).rejects.toThrow("Commit failed");
    await expect(
      store.collect(() => {
        throw new Error("Reference read failed");
      }),
    ).rejects.toThrow("Reference read failed");
    expect(await store.collect(() => new Set())).toBe(1);
    const file = await store.publishing(() => store.put("After recovery"));
    expect((await store.read(file.hash)).toString()).toBe("After recovery");
  });
});
