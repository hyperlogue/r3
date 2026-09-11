import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface StoredBlob {
  hash: string;
  byteLength: number;
}

export function hashBytes(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isFsError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

// Bytes become visible before their SQL reference commits. Installation is
// create-only and durable; an interrupted publication can leave an unreferenced
// blob, but can never replace bytes already referenced by a published version.
// The caller owns the private directory and coordinates any garbage collection
// with publications. There is deliberately no per-version deletion operation.
export class BlobStore {
  private publications = 0;
  private cleaning: Promise<void> | null = null;
  private drained: (() => void) | null = null;
  constructor(private readonly root: string) {}

  // Hold this through the SQL commit, not just the byte writes: an installed
  // blob has no SQL reference yet while its publication is still preparing.
  async publishing<T>(work: () => Promise<T>): Promise<T> {
    while (this.cleaning) await this.cleaning;
    this.publications++;
    try {
      return await work();
    } finally {
      if (--this.publications === 0) {
        this.drained?.();
        this.drained = null;
      }
    }
  }

  async collect(references: () => ReadonlySet<string>): Promise<number> {
    const previous = this.cleaning;
    let unlock!: () => void;
    const current = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    this.cleaning = current;
    let removed = 0;
    try {
      if (previous) await previous;
      if (this.publications)
        await new Promise<void>((resolve) => {
          this.drained = resolve;
        });
      // Take the mark set after earlier publications have committed, with new
      // publications held until cleanup finishes. Whole-artifact deletion may
      // make this set conservative, which is safe until the next collection.
      const live = references();
      const directories = await readdir(this.root, { withFileTypes: true }).catch((error) => {
        if (isFsError(error, "ENOENT")) return [];
        throw error;
      });
      for (const entry of directories) {
        if (!entry.isDirectory() || !/^[0-9a-f]{2}$/.test(entry.name)) continue;
        const directory = join(this.root, entry.name);
        let changed = false;
        for (const file of await readdir(directory, { withFileTypes: true })) {
          if (!file.isFile()) continue;
          const hash = entry.name + file.name;
          const temporary = /^\.upload-[0-9a-f-]{36}$/.test(file.name);
          if (!temporary && (!/^[0-9a-f]{64}$/.test(hash) || live.has(hash))) continue;
          await unlink(join(directory, file.name));
          removed++;
          changed = true;
        }
        if (changed) {
          const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
        }
      }
      return removed;
    } finally {
      if (this.cleaning === current) this.cleaning = null;
      unlock();
    }
  }

  private location(hash: string): { directory: string; file: string } {
    if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error("Invalid blob hash");
    const directory = join(this.root, hash.slice(0, 2));
    return { directory, file: join(directory, hash.slice(2)) };
  }

  async put(input: Uint8Array | string): Promise<StoredBlob> {
    // Own the buffer across awaits: callers may reuse an upload buffer.
    const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
    const hash = hashBytes(bytes);
    const { directory, file } = this.location(hash);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(directory, { mode: 0o700 }).catch((error: unknown) => {
      if (!isFsError(error, "EEXIST")) throw error;
    });
    const temporary = join(directory, `.upload-${randomUUID()}`);
    const output = await open(temporary, "wx", 0o600);
    try {
      await output.writeFile(bytes);
      await output.sync();
      await output.close();
      try {
        // Unlike rename, link cannot overwrite an existing blob.
        await link(temporary, file);
      } catch (error) {
        if (!isFsError(error, "EEXIST")) throw error;
        const existing = await this.read(hash);
        if (!existing.equals(bytes)) throw new Error("Stored blob does not match its digest");
      }
      // Persist the directory entry before SQL is allowed to refer to it.
      for (const path of [directory, this.root]) {
        const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
      return { hash, byteLength: bytes.byteLength };
    } finally {
      await output.close();
      await unlink(temporary);
    }
  }

  async read(hash: string): Promise<Buffer> {
    const { file } = this.location(hash);
    // A store entry is always a regular file owned by this store. Never follow
    // an accidentally substituted symlink to content outside it.
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!(await handle.stat()).isFile()) throw new Error("Blob is not a regular file");
      const bytes = await handle.readFile();
      if (hashBytes(bytes) !== hash) throw new Error("Stored blob does not match its digest");
      return bytes;
    } finally {
      await handle.close();
    }
  }
}
