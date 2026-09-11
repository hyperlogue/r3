import { lstat, realpath } from "node:fs/promises";
import { basename } from "node:path";
import { captureFiles } from "../cli/capture.ts";
import { captureGitDiff, captureGitFiles, publisherGit } from "../cli/capture-git.ts";
import { requireArtifactPath } from "./artifact-validation.ts";
import type { LegacyCapture } from "./migration-content.ts";
import { type LegacyRow, legacyId, legacyObject, legacyText } from "./migration-data.ts";

async function worktree(
  commonDir: string,
  descriptor: Record<string, unknown>,
): Promise<string | null> {
  const listed = await publisherGit(commonDir, ["worktree", "list", "--porcelain", "-z"]);
  if (listed.code) return null;
  const candidates: { path: string; branch: string | null }[] = [];
  let current: (typeof candidates)[number] | null = null;
  for (const line of listed.stdout.toString().split("\0")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice(9), branch: null };
      candidates.push(current);
    } else if (current && line.startsWith("branch refs/heads/")) current.branch = line.slice(18);
  }
  const common = await realpath(commonDir);
  let branchFallback: string | null = null;
  for (const candidate of candidates) {
    try {
      if (!(await lstat(candidate.path)).isDirectory()) continue;
      const result = await publisherGit(candidate.path, [
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
      ]);
      if (result.code) continue;
      const gitDir = await realpath(result.stdout.toString().trim());
      const primary = gitDir === common;
      if (!descriptor.name && primary) return candidate.path;
      if (descriptor.name && !primary && basename(gitDir) === descriptor.name)
        return candidate.path;
      if (descriptor.branch && candidate.branch === descriptor.branch)
        branchFallback = candidate.path;
    } catch {
      /* A removed worktree stays unavailable. */
    }
  }
  return descriptor.name ? branchFallback : null;
}

function selectedFiles(source: Record<string, unknown>): string[] {
  if (!Array.isArray(source.files) || source.files.some((file) => typeof file !== "string"))
    throw new Error("Legacy source has no valid file membership");
  return source.files.map(requireArtifactPath);
}

async function localCapture(
  review: LegacyRow,
  repo: LegacyRow | null,
  scratchRoot: string,
  docsRoot: string,
): ReturnType<LegacyCapture> {
  const source = legacyObject(review.source);
  if (review.kind === "doc") {
    const path = requireArtifactPath(source.doc);
    return { kind: "files", files: await captureFiles(docsRoot, [path]) };
  }
  if (source.ref === "SCRATCH") {
    const id = requireArtifactPath(legacyId(review.id));
    // Directory capture includes assets beneath the old scratch review while
    // preserving its root-relative paths and relative document links.
    try {
      return { kind: "files", files: await captureFiles(scratchRoot, [id]) };
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
      return { kind: "files", files: await captureFiles(scratchRoot, selectedFiles(source)) };
    }
  }
  const commonDir = legacyText(repo?.common_dir);
  if (!commonDir) return { unavailable: "No legacy project location survives" };
  const ref = legacyText(source.ref);
  const needsWorktree =
    ref === "WORKING" ||
    ref === "STAGED" ||
    source.head === "WORKING" ||
    source.head === "STAGED" ||
    source.base === "STAGED";
  const root = needsWorktree ? await worktree(commonDir, legacyObject(review.worktree)) : commonDir;
  if (!root) return { unavailable: "The original worktree is no longer available" };
  if (review.kind === "files" && ref) {
    const paths = selectedFiles(source);
    return {
      kind: "files",
      files:
        ref === "WORKING"
          ? await captureFiles(root, paths)
          : await captureGitFiles(root, ref, paths),
    };
  }
  if (
    review.kind === "diff" &&
    typeof source.base === "string" &&
    typeof source.head === "string"
  ) {
    return { kind: "diff", patch: await captureGitDiff(root, source.base, source.head) };
  }
  return { unavailable: "Legacy source does not identify capturable content" };
}

// This adapter is used only during the storage upgrade, before serving clients.
// Published reads never retain it or use these publisher-local locations.
export function legacyLocalCapture(roots: {
  scratchRoot: string;
  docsRoot: string;
}): LegacyCapture {
  return async (review, repo) => {
    try {
      return await localCapture(review, repo, roots.scratchRoot, roots.docsRoot);
    } catch (error) {
      return { unavailable: error instanceof Error ? error.message : "Local capture failed" };
    }
  };
}
