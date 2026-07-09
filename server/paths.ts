// Path-safety + repo-root discovery. The v2 daemon is multi-repo:
// a per-request `Repo` (server/repo.ts) carries the worktree root and validates
// paths against it. This module keeps only the *pure* helpers — root discovery
// and the repo-relative path guard — plus DEFAULT_ROOT, the fallback repo used
// for requests that carry no repo context (e.g. a header-less curl, or the
// browser before it picks a project).

import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

// Walk up for `.git` (a dir in the primary worktree, a file in a linked one) the
// way git itself locates a repo.
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(start); // no .git — fall back so the tool still runs
    dir = parent;
  }
}

// The daemon's default repo: where it was launched (R3_ROOT or cwd). Used only
// as a fallback for requests with no x-r3-repo header / ?repo selector.
export const DEFAULT_ROOT = findRepoRoot(process.env.R3_ROOT ?? process.cwd());

// Resolve a repo-relative path against `root`, refusing anything that escapes it.
// Returns the absolute path, or null if the input is unsafe (absolute, or `..`).
export function safePathIn(root: string, p: string): string | null {
  if (!p || typeof p !== "string") return null;
  if (isAbsolute(p)) return null;
  if (p.split(/[/\\]/).includes("..")) return null;
  const abs = resolve(root, p);
  return abs === root || abs.startsWith(root + sep) ? abs : null;
}

// Symlink-escape guard for the actual read/open sites. `safePathIn` is
// deliberately *lexical* (it must also validate not-yet-existing paths for
// membership edits), so a file that lives inside `root` but is itself a symlink
// to `/etc/passwd` passes it — the lexical path never leaves the root, yet a
// `readFileSync`/editor open would follow the link out. We review untrusted
// AI-/PR-authored trees, so a planted in-repo symlink must not be able to
// exfiltrate files outside the review root. At the point of use we additionally
// resolve symlinks: realpath the candidate (and the root, for a fair compare)
// and confirm the real target still lies within. Returns false when the realpath
// escapes, or when either path can't be resolved (e.g. it doesn't exist) — the
// caller then falls back to its existing "not found / bad path" handling.
export function realpathWithin(root: string, abs: string): boolean {
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(abs);
    return real === realRoot || real.startsWith(realRoot + sep);
  } catch {
    return false;
  }
}
