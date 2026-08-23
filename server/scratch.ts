// Scratch reviews: adhoc files outside any git repo. scratchSafePath is the
// second allowed path root besides the worktree.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { Review } from "../shared/types.ts";
import { stateDir } from "./config.ts";
import { safePathIn } from "./paths.ts";

// $XDG_STATE_HOME/r3/scratch — a daemon-owned root, alongside the global sqlite.
export function scratchDir(): string {
  return join(stateDir(), "scratch");
}

// The per-review directory the agent drops files into.
export function scratchReviewDir(id: string): string {
  return join(scratchDir(), id);
}

// Create the per-review scratch directory; returns its absolute path.
export function createScratchDir(id: string): string {
  const dir = scratchReviewDir(id);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Remove a review's scratch directory (used to clean up a failed create).
export function removeScratchDir(id: string): void {
  rmSync(scratchReviewDir(id), { recursive: true, force: true });
}

// Validate a scratch-relative path against the scratch root (repo-relative, no
// `..`, no absolute — the same guard the worktree uses), yielding the absolute
// path or null. This is what keeps ref:'SCRATCH' from escaping the scratch dir.
export function scratchSafePath(rel: string): string | null {
  return safePathIn(scratchDir(), rel);
}

// True when a review's content lives in the scratch dir (a files/SCRATCH review).
// A type guard so callers get `source.files` narrowed.
export function isScratchReview(
  review: Review,
): review is Review & { source: { ref: string; files: string[] } } {
  return "ref" in review.source && review.source.ref === "SCRATCH";
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Whether a scratch review has a per-review directory (a `--scratch` review) vs.
// a legacy single-file scratch doc. Drives dir-watching in watcher.ts.
export function hasScratchDir(id: string): boolean {
  return isDir(scratchReviewDir(id));
}

// A scratch review's current files, as scratch-relative paths. A `--scratch`
// review has a directory → a flat (top-level, non-recursive) scan of it, the same
// set the watcher watches, so what's shown always matches what's watched. A legacy
// single-file scratch doc (no directory) falls back to its stored source.files.
export function scratchFiles(review: Review): string[] {
  if (!isScratchReview(review)) return [];
  const dir = scratchReviewDir(review.id);
  if (!isDir(dir)) return review.source.files;
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => `${review.id}/${e.name}`)
      .sort();
  } catch {
    return [];
  }
}

// Subdirectory names inside a scratch review's directory. Scratch reviews are
// flat (top-level files only, watched non-recursively), so any subdirectory is
// ignored — the UI warns about these so files dropped in one aren't silently lost.
export function scratchIgnoredDirs(review: Review): string[] {
  if (!isScratchReview(review)) return [];
  const dir = scratchReviewDir(review.id);
  if (!isDir(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

// Remove a scratch review's backing storage: its per-review directory (a
// `--scratch` review) plus any legacy flat file(s) it still references.
export function deleteScratch(review: Review): void {
  if (!isScratchReview(review)) return;
  rmSync(scratchReviewDir(review.id), { recursive: true, force: true });
  for (const f of review.source.files) {
    // Only this review's OWN legacy flat doc. `scratchSafePath` is rooted at the
    // whole scratch tree (that root is the documented read boundary), so an
    // unscoped unlink here deletes whatever path the row happens to name —
    // including another live review's files. The `--scratch` directory is
    // already gone wholesale on the line above; this loop exists purely for the
    // pre-directory `scratch/<id>.md` layout.
    if (f !== `${review.id}.md`) continue;
    const abs = scratchSafePath(f);
    if (abs)
      try {
        rmSync(abs);
      } catch {}
  }
}

// One-time filesystem migration paired with db.ts's row conversion: the old
// `kind:'doc'` reviews stored their markdown under `<state>/docs/<id>.md`; the
// files/SCRATCH form reads it from `<state>/scratch/<id>.md`. Move every leftover
// doc file into the scratch dir and drop the empty legacy dir. Idempotent: a no-op
// once `docs/` is gone. Called from startDaemon().
export function migrateLegacyDocFiles(): void {
  const legacy = join(stateDir(), "docs");
  if (!existsSync(legacy)) return;
  let names: string[];
  try {
    names = readdirSync(legacy);
  } catch {
    return;
  }
  if (names.length) mkdirSync(scratchDir(), { recursive: true });
  for (const name of names) {
    const dest = join(scratchDir(), name);
    if (existsSync(dest)) continue; // already migrated — don't clobber
    try {
      renameSync(join(legacy, name), dest);
    } catch {}
  }
  try {
    rmdirSync(legacy); // only succeeds once empty
  } catch {}
}
