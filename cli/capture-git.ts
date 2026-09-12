import { requireArtifactPath } from "../server/artifact-validation.ts";
import { trimOversizedFiles } from "../server/git.ts";
import { PUBLICATION_LIMITS } from "../server/publication.ts";
import type { PublicationFile } from "../shared/artifacts.ts";
import { CaptureError, mediaTypeForPath } from "./capture.ts";

export async function publisherGit(
  root: string,
  args: string[],
): Promise<{ stdout: Buffer; stderr: string; code: number }> {
  const child = Bun.spawn(
    ["git", "-c", "core.quotepath=false", "-c", "core.fsmonitor=false", "--no-pager", ...args],
    {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 30_000,
      killSignal: "SIGKILL",
    },
  );
  async function read(stream: ReadableStream<Uint8Array>, limit: number): Promise<Buffer> {
    const reader = stream.getReader();
    const chunks: Buffer[] = [];
    let length = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > limit) {
          child.kill();
          throw new CaptureError("Git capture exceeds the output size limit");
        }
        chunks.push(Buffer.from(chunk.value));
      }
      return Buffer.concat(chunks, length);
    } finally {
      reader.releaseLock();
    }
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [stdout, stderr, code] = await Promise.race([
      Promise.all([
        read(child.stdout, PUBLICATION_LIMITS.totalBytes * 2),
        read(child.stderr, 64 * 1024),
        child.exited,
      ]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          child.kill();
          reject(new CaptureError("Git capture timed out"));
        }, 31_000);
      }),
    ]);
    return { stdout, stderr: stderr.toString(), code };
  } finally {
    clearTimeout(timer);
  }
}

async function git(root: string, args: string[]): Promise<Buffer> {
  const result = await publisherGit(root, args);
  if (result.code !== 0) throw new CaptureError(`Git capture failed: ${result.stderr.trim()}`);
  return result.stdout;
}

export function safePublisherRef(ref: string): string {
  if (!ref || ref.startsWith("-") || /[\0\r\n]/.test(ref))
    throw new CaptureError("Invalid git reference");
  return ref;
}

async function tree(root: string, ref: string): Promise<string> {
  return (
    await git(root, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${safePublisherRef(ref)}^{tree}`,
    ])
  )
    .toString()
    .trim();
}

async function emptyTree(root: string): Promise<string> {
  // Let Git choose the object format; mktree reads an empty stdin.
  return (await git(root, ["mktree"])).toString().trim();
}

async function baseTree(root: string, ref: string): Promise<string> {
  try {
    return await tree(root, ref);
  } catch (error) {
    if (ref !== "HEAD") throw error;
    const branch = await publisherGit(root, ["symbolic-ref", "--quiet", "HEAD"]);
    if (branch.code !== 0) throw error;
    const exists = await publisherGit(root, [
      "show-ref",
      "--verify",
      "--quiet",
      branch.stdout.toString().trim(),
    ]);
    if (exists.code !== 1) throw error;
    return emptyTree(root);
  }
}

export async function captureGitCommit(root: string, ref: string): Promise<string> {
  const commit = (
    await git(root, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${safePublisherRef(ref)}^{commit}`,
    ])
  )
    .toString()
    .trim();
  const [, parent] = (await git(root, ["rev-list", "--parents", "-n", "1", commit]))
    .toString()
    .trim()
    .split(/\s+/);
  return captureGitDiff(root, parent ?? (await emptyTree(root)), commit);
}

// Resolve commits once, or verify the complete index listing before/after its
// immutable blob reads. Git file capture never follows a filesystem symlink.
export async function captureGitFiles(
  root: string,
  ref: string,
  paths: string[],
): Promise<PublicationFile[]> {
  for (const path of paths) requireArtifactPath(path);
  if (!paths.length) throw new CaptureError("Select git files to publish");
  const staged = ref === "STAGED";
  const revision = staged ? null : await tree(root, ref);
  const args = staged ? ["ls-files", "--stage", "-z"] : ["ls-tree", "-r", "-z", revision!];
  const listing = await git(root, args);
  const entries = listing
    .toString()
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+) (?:blob |commit )?([0-9a-f]+)(?: (\d))?\t(.*)$/s.exec(line);
      if (!match) throw new CaptureError("Cannot read git file membership");
      return { mode: match[1], oid: match[2], stage: match[3], path: match[4] };
    })
    .filter((entry) =>
      paths.some((path) => entry.path === path || entry.path.startsWith(`${path}/`)),
    );
  for (const path of paths)
    if (!entries.some((entry) => entry.path === path || entry.path.startsWith(`${path}/`)))
      throw new CaptureError(`Selected path is absent from the git version: ${path}`);
  const files: PublicationFile[] = [];
  let total = 0;
  for (const entry of entries) {
    requireArtifactPath(entry.path);
    if (!["100644", "100755"].includes(entry.mode) || (staged && entry.stage !== "0"))
      throw new CaptureError(
        "Materialize symlinks/submodules and resolve the index before publishing",
      );
    const size = Number((await git(root, ["cat-file", "-s", entry.oid])).toString());
    total += size;
    if (
      size > PUBLICATION_LIMITS.fileBytes ||
      total > PUBLICATION_LIMITS.totalBytes ||
      files.length >= PUBLICATION_LIMITS.files
    )
      throw new CaptureError("Selected git files exceed the publication size limits");
    const bytes = await git(root, ["cat-file", "blob", entry.oid]);
    if (bytes.length !== size) throw new CaptureError("Git object length changed during capture");
    files.push({
      path: entry.path,
      mediaType: mediaTypeForPath(entry.path),
      base64: bytes.toString("base64"),
    });
  }
  if (staged && !(await git(root, args)).equals(listing))
    throw new CaptureError("Git index changed during capture; retry with stable input");
  return files;
}

export async function captureGitDiff(root: string, base: string, head: string): Promise<string> {
  safePublisherRef(base);
  safePublisherRef(head);
  const baseRevision = base === "STAGED" ? null : await baseTree(root, base);
  const headTree = head === "WORKING" || head === "STAGED" ? null : await tree(root, head);
  if (base === "STAGED" && head !== "WORKING")
    throw new CaptureError("A staged base requires a working-tree head");
  const args = [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    "--find-renames",
    "--unified=2000",
  ];
  if (head === "WORKING") {
    if (baseRevision) args.push(baseRevision);
  } else if (head === "STAGED") args.push("--cached", baseRevision!);
  else args.push(baseRevision!, headTree!);
  args.push("--");
  async function capture(): Promise<string> {
    let patch = (await git(root, args)).toString();
    if (head === "WORKING") {
      const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]))
        .toString()
        .split("\0")
        .filter(Boolean);
      for (const path of untracked) {
        requireArtifactPath(path);
        const file = await publisherGit(root, [
          "diff",
          "--no-index",
          "--no-color",
          "--no-ext-diff",
          "--no-textconv",
          "--binary",
          "--unified=2000",
          "--",
          "/dev/null",
          path,
        ]);
        if (file.code > 1)
          throw new CaptureError(`Untracked diff capture failed: ${file.stderr.trim()}`);
        patch += file.stdout.toString();
        if (Buffer.byteLength(patch) > PUBLICATION_LIMITS.totalBytes * 2)
          throw new CaptureError("Git patch capture exceeds the output size limit");
      }
    }
    return patch;
  }
  const raw = await capture();
  if ((head === "WORKING" || head === "STAGED") && (await capture()) !== raw)
    throw new CaptureError("Git inputs changed during capture; retry with stable input");
  let patch = trimOversizedFiles(raw);
  if (Buffer.byteLength(patch) > PUBLICATION_LIMITS.patchBytes)
    patch = trimOversizedFiles(patch, 3, 0);
  if (!patch.trim()) throw new CaptureError("There are no changes to publish");
  if (Buffer.byteLength(patch) > PUBLICATION_LIMITS.patchBytes)
    throw new CaptureError("Patch exceeds the publication size limit");
  return patch;
}
