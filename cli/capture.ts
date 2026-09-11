import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { requireArtifactPath } from "../server/artifact-validation.ts";
import { PUBLICATION_LIMITS } from "../server/publication.ts";
import type { PublicationFile } from "../shared/artifacts.ts";

export class CaptureError extends Error {}

type Entry = { path: string; kind: "file" | "directory"; stamp: string; size: number };

function stamp(info: Awaited<ReturnType<typeof lstat>>): string {
  return [info.dev, info.ino, info.mode, info.size, info.mtimeMs, info.ctimeMs].join(":");
}

export function mediaTypeForPath(path: string): string {
  if (/\.(md|markdown)$/i.test(path)) return "text/markdown; charset=utf-8";
  return Bun.file(path).type || "application/octet-stream";
}

// The complete selected membership is captured twice around the byte reads.
// No daemon path or git context is needed to upload the resulting wire files.
// Symlinks and special files must be materialized into a prepared directory.
export async function captureFiles(
  root: string,
  paths: string[] = ["."],
): Promise<PublicationFile[]> {
  const directory = await realpath(root);
  if (!(await lstat(directory)).isDirectory())
    throw new CaptureError("Capture root must be a directory");
  const selected = [...new Set(paths)].sort();
  if (!selected.length) throw new CaptureError("Select files or a directory to publish");
  for (const path of selected) if (path !== ".") requireArtifactPath(path);

  async function scan(): Promise<Map<string, Entry>> {
    const entries = new Map<string, Entry>();
    let fileCount = 0;
    let total = 0;
    async function visit(path: string, depth: number): Promise<void> {
      if (entries.has(path)) return;
      if (depth > 128) throw new CaptureError("Publication directory nesting is too deep");
      const absolute = join(directory, path);
      const info = await lstat(absolute);
      if (info.isSymbolicLink())
        throw new CaptureError(`Materialize the symbolic link before publishing: ${path}`);
      const resolved = await realpath(absolute);
      const within = relative(directory, resolved);
      if (within === ".." || within.startsWith(`..${sep}`))
        throw new CaptureError("Capture path escapes the selected directory");
      if (resolved !== absolute)
        throw new CaptureError(`Materialize symbolic link directories before publishing: ${path}`);
      if (info.isDirectory()) {
        entries.set(path, { path, kind: "directory", stamp: stamp(info), size: info.size });
        for (const child of (await readdir(absolute)).sort()) {
          const member = path === "." ? child : `${path}/${child}`;
          requireArtifactPath(member);
          await visit(member, depth + 1);
        }
      } else if (info.isFile()) {
        total += info.size;
        fileCount++;
        if (
          fileCount > PUBLICATION_LIMITS.files ||
          total > PUBLICATION_LIMITS.totalBytes ||
          info.size > PUBLICATION_LIMITS.fileBytes
        ) {
          throw new CaptureError("Selected files exceed the publication size limits");
        }
        entries.set(path, { path, kind: "file", stamp: stamp(info), size: info.size });
      } else throw new CaptureError(`Publication contains a non-regular file: ${path}`);
    }
    for (const path of selected) await visit(path, 0);
    return entries;
  }

  const before = await scan();
  const files: PublicationFile[] = [];
  for (const entry of [...before.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )) {
    if (entry.kind !== "file") continue;
    const handle = await open(
      join(directory, entry.path),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      const first = await handle.stat();
      if (!first.isFile() || stamp(first) !== entry.stamp)
        throw new CaptureError("Files changed during capture; publish from a stable directory");
      // Bound allocation even if a writer grows the file after its initial stat.
      const bytes = Buffer.alloc(entry.size + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await handle.read(bytes, length, bytes.length - length, length);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length !== entry.size || stamp(await handle.stat()) !== entry.stamp)
        throw new CaptureError("Files changed during capture; publish from a stable directory");
      files.push({
        path: entry.path,
        mediaType: mediaTypeForPath(entry.path),
        base64: bytes.subarray(0, length).toString("base64"),
      });
    } finally {
      await handle.close();
    }
  }
  const after = await scan();
  if (
    before.size !== after.size ||
    [...before].some(([path, entry]) => after.get(path)?.stamp !== entry.stamp)
  ) {
    throw new CaptureError(
      "Directory membership or content changed during capture; retry with stable input",
    );
  }
  if (!files.length) throw new CaptureError("A publication must contain at least one file");
  return files;
}
