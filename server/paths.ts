// Path-safety helpers. The v2 daemon is multi-repo and repo-agnostic: a
// per-request `Repo` (server/repo.ts) carries the worktree root and validates
// paths against it, resolved fresh per request from the review id, the CLI's
// x-r3-repo header, or a ?repo selector. This module keeps only the *pure*
// helpers — the repo-relative path guard and its symlink-escape check.

import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

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
