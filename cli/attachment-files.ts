import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, link, mkdir, open, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ArtifactClient } from "../shared/artifact-client.ts";
import {
  type ArtifactAttachment,
  ATTACHMENT_LIMITS,
  type AttachmentInput,
  attachmentPath,
} from "../shared/attachments.ts";
import { ArtifactCommandError } from "./artifact-args.ts";

// Open without waiting for a pipe writer, then validate the opened descriptor.
// Bound reads even when a regular file grows after its initial size check.
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
async function readStableImage(file: FileHandle): Promise<Buffer> {
  const before = await file.stat();
  if (!before.isFile() || before.size > ATTACHMENT_LIMITS.bytes) throw new Error();
  const bytes = Buffer.alloc(before.size + 1);
  let size = 0;
  while (size < bytes.length) {
    const result = await file.read(bytes, size, bytes.length - size, null);
    if (!result.bytesRead) break;
    size += result.bytesRead;
  }
  const after = await file.stat();
  if (
    size !== before.size ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs
  )
    throw new Error();
  return bytes.subarray(0, size);
}

export async function readAttachmentFiles(
  paths: string[],
  cwd: string,
): Promise<AttachmentInput[]> {
  if (paths.length > ATTACHMENT_LIMITS.count)
    throw new ArtifactCommandError("A message can contain at most four images");
  const images: AttachmentInput[] = [];
  for (const path of paths) {
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      file = await open(resolve(cwd, path), readFlags);
      const bytes = await readStableImage(file);
      const mediaType =
        bytes[0] === 137 ? "image/png" : bytes[0] === 255 && bytes[1] === 216 ? "image/jpeg" : null;
      if (!mediaType) throw new Error();
      images.push({ mediaType, base64: bytes.toString("base64") });
    } catch {
      throw new ArtifactCommandError(
        "Unable to read an attachment: choose a regular PNG/JPEG file of at most 5 MiB that is not changing",
      );
    } finally {
      await file?.close();
    }
  }
  return images;
}

export async function downloadAttachment(
  client: ArtifactClient,
  artifactId: string,
  id: string,
): Promise<Uint8Array> {
  const response = await client.request("GET", attachmentPath(artifactId, id));
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Missing attachment bytes");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > ATTACHMENT_LIMITS.bytes) {
        await reader.cancel();
        throw new Error("Attachment exceeds its size limit");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export async function saveAttachment(path: string, bytes: Uint8Array) {
  const temporary = `${path}.r3-${randomUUID()}`;
  const file = await open(temporary, "wx", 0o600).catch(() => {
    throw new Error("Attachment output cannot be created");
  });
  try {
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    await link(temporary, path).catch(() => {
      throw new Error("Attachment output already exists or cannot be created");
    });
  } finally {
    await file.close();
    await unlink(temporary);
  }
}

export async function downloadDiscussionImages(
  client: ArtifactClient,
  images: ArtifactAttachment[],
  directory: string,
): Promise<string[]> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const saved: string[] = [];
  for (const image of images) {
    if (!/^image_[a-f0-9]{32}$/.test(image.id) || !/^[a-f0-9]{64}$/.test(image.hash))
      throw new Error("Invalid attachment manifest");
    const name = `${image.id}.${image.mediaType === "image/png" ? "png" : "jpg"}`;
    const path = join(directory, name);
    const matches = (bytes: Uint8Array) =>
      bytes.byteLength === image.byteLength &&
      createHash("sha256").update(bytes).digest("hex") === image.hash;
    let existing: Uint8Array | undefined;
    // A retry can reuse exactly the immutable bytes it already saved.
    const handle = await open(path, readFlags).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw new Error("Attachment output cannot be read safely");
    });
    if (handle) {
      try {
        existing = await readStableImage(handle).catch(() => {
          throw new Error("Attachment output differs from the snapshot");
        });
      } finally {
        await handle.close();
      }
      if (!matches(existing)) throw new Error("Attachment output differs from the snapshot");
    } else {
      const bytes = await downloadAttachment(client, image.artifactId, image.id);
      if (!matches(bytes)) throw new Error("Attachment bytes differ from the discussions snapshot");
      await saveAttachment(path, bytes);
    }
    saved.push(path);
  }
  return saved;
}
