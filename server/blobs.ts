import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, mkdir, open, unlink } from "node:fs/promises";
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
  constructor(private readonly root: string) {}

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
