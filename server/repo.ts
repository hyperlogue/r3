// Per-request Repo context + project identity, registry, and
// worktree resolution. A `Repo` carries everything a request
// needs to act on one project's working tree: the registry id, the common-dir
// (identity), the resolved worktree path used as git cwd + path-validation root,
// and bound `git()` / `safePath()` helpers. The global sqlite is the only
// process-wide singleton; everything else is resolved per request — from the
// CLI's `x-r3-repo` header, a `?repo=<id>` selector, a stored review row, or the
// daemon's DEFAULT_ROOT fallback.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import type { RepoRecord, Review, ReviewSource, WorktreeDescriptor } from "../shared/types.ts";
import * as db from "./db.ts";
import { runGitIn } from "./git.ts";
import { DEFAULT_ROOT, safePathIn } from "./paths.ts";

export interface Repo {
  repoId: string;
  commonDir: string;
  worktreePath: string;
  name: string;
  descriptor: WorktreeDescriptor | null;
  // The live tree couldn't be resolved (worktree removed, or repo path missing).
  // Content is unavailable/last-known and the UI offers relink.
  stale: boolean;
  git(args: string[]): Promise<{ stdout: string; stderr: string; code: number }>;
  gitText(args: string[]): Promise<string>;
  safePath(p: string): string | null;
}

function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function makeRepo(
  f: Pick<Repo, "repoId" | "commonDir" | "worktreePath" | "name" | "descriptor" | "stale">,
): Repo {
  return {
    ...f,
    git: (args) => runGitIn(f.worktreePath, args),
    gitText: async (args) => {
      const { stdout, stderr, code } = await runGitIn(f.worktreePath, args);
      if (code !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr.trim()}`);
      return stdout;
    },
    safePath: (p) => safePathIn(f.worktreePath, p),
  };
}

// A diff between two immutable commits (or a fileset pinned to a sha) never
// moves and reads from the shared object store, so it's worktree-independent —
// used both to skip re-anchoring (reviews.ts) and to decide whether a removed
// worktree leaves a review stale or merely falls back to the primary.
export function isImmutableSource(source: ReviewSource): boolean {
  // WORKING/STAGED track the live worktree; SCRATCH tracks an editable doc in the
  // scratch dir. All three drift, so they re-anchor; any other ref is a pinned
  // sha/ref that never moves.
  if ("ref" in source)
    return source.ref !== "WORKING" && source.ref !== "STAGED" && source.ref !== "SCRATCH";
  return (
    source.base !== "WORKING" &&
    source.base !== "STAGED" &&
    source.head !== "WORKING" &&
    source.head !== "STAGED"
  );
}

// ---- worktree enumeration (derived live from git, never persisted) ----

interface LiveWorktree {
  path: string;
  branch: string | null;
  name: string; // basename under .git/worktrees/<name>; "" = primary
}

// Map each linked worktree's current path → its stable name, by reading
// `<commonDir>/worktrees/<name>/gitdir` (which git rewrites on `worktree move`).
function worktreeNameMap(commonDir: string): Map<string, string> {
  const map = new Map<string, string>();
  const wtDir = join(commonDir, "worktrees");
  let names: string[];
  try {
    names = readdirSync(wtDir); // throws if absent/unreadable — degrade to empty
  } catch {
    return map;
  }
  for (const name of names) {
    try {
      const gitdir = readFileSync(join(wtDir, name, "gitdir"), "utf8").trim();
      // gitdir points at "<worktreepath>/.git" (a file in the linked worktree).
      map.set(realpathOrSelf(dirname(gitdir)), name);
    } catch {}
  }
  return map;
}

async function listWorktrees(commonDir: string): Promise<LiveWorktree[]> {
  const { stdout, code } = await runGitIn(commonDir, ["worktree", "list", "--porcelain"]);
  if (code !== 0) return [];
  const names = worktreeNameMap(commonDir);
  const out: LiveWorktree[] = [];
  let cur: LiveWorktree | null = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur) out.push(cur);
      cur = { path: line.slice("worktree ".length), branch: null, name: "" };
    } else if (cur && line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    }
  }
  if (cur) out.push(cur);
  for (const w of out) w.name = names.get(realpathOrSelf(w.path)) ?? "";
  return out;
}

// Resolve a stored worktree descriptor to a live path. Match by name (stable
// across `git worktree move`), falling back to branch; `null`/empty descriptor =
// the primary worktree. Returns { path:null } when the worktree is gone.
async function resolveWorktreePath(
  commonDir: string,
  descriptor: WorktreeDescriptor | null,
): Promise<{ path: string | null; primary: string | null }> {
  // Only consider worktrees whose directory still exists: `git worktree list`
  // keeps listing a worktree whose dir was `rm -rf`d (until pruned), and using
  // that dead path as a git cwd would throw ENOENT rather than resolve stale.
  const wts = (await listWorktrees(commonDir)).filter((w) => existsSync(w.path));
  const primary = (wts.find((w) => w.name === "") ?? wts[0])?.path ?? null;
  if (!descriptor?.name) return { path: primary, primary };
  let match = wts.find((w) => w.name === descriptor.name);
  if (!match && descriptor.branch) match = wts.find((w) => w.branch === descriptor.branch);
  return { path: match?.path ?? null, primary };
}

// ---- registration ----

// A reasonable default display name for a freshly-seen repo: the primary
// worktree's basename (dirname of `<root>/.git`); editable later via relink/UI.
function defaultRepoName(commonDir: string): string {
  const base = basename(dirname(commonDir));
  return base || basename(commonDir) || "repo";
}

function registerByCommonDir(commonDir: string, remote: string | null): RepoRecord {
  return db.registerRepo(commonDir, defaultRepoName(commonDir), remote);
}

// Confirm `worktreePath` is genuinely a checkout whose object store is
// `commonDir`, by reading its `.git` pointer (no git subprocess). A primary
// worktree's `.git` is a directory == commonDir; a linked worktree's `.git` is a
// file `gitdir: <commonDir>/worktrees/<name>`. This stops a client-supplied
// x-r3-repo header from pairing an arbitrary directory (e.g. `$HOME`) with a real
// common-dir to read files outside any repo.
function worktreeBelongsTo(worktreePath: string, commonDir: string): boolean {
  const dotgit = join(worktreePath, ".git");
  let st: ReturnType<typeof statSync>;
  try {
    st = statSync(dotgit);
  } catch {
    return false;
  }
  if (st.isDirectory()) return realpathOrSelf(dotgit) === commonDir;
  try {
    const m = readFileSync(dotgit, "utf8")
      .trim()
      .match(/^gitdir:\s*(.+)$/);
    if (!m) return false;
    const target = realpathOrSelf(m[1].trim()); // <commonDir>/worktrees/<name>
    return target === commonDir || target.startsWith(commonDir + sep);
  } catch {
    return false;
  }
}

// ---- resolvers ----

interface RepoHeaderPayload {
  commonDir: string;
  worktreePath: string;
  name?: string;
  branch?: string | null;
  remote?: string | null;
}

// From the CLI's `x-r3-repo` header: a base64 JSON descriptor the client computed
// from its own checkout. Trust-but-verify — both paths must exist AND the
// worktree must actually belong to the common-dir — then register.
export function resolveRepoFromHeader(b64: string): Repo | null {
  let p: RepoHeaderPayload;
  try {
    p = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch {
    return null;
  }
  if (!p?.commonDir || !p?.worktreePath) return null;
  if (!existsSync(p.commonDir) || !existsSync(p.worktreePath)) return null;
  const commonDir = realpathOrSelf(p.commonDir);
  const worktreePath = realpathOrSelf(p.worktreePath);
  if (!worktreeBelongsTo(worktreePath, commonDir)) return null;
  const rec = registerByCommonDir(commonDir, p.remote ?? null);
  const descriptor: WorktreeDescriptor = {
    name: p.name ?? "",
    branch: p.branch ?? null,
    pathHint: worktreePath,
  };
  return makeRepo({
    repoId: rec.id,
    commonDir,
    worktreePath,
    name: rec.name ?? basename(worktreePath),
    descriptor,
    stale: false,
  });
}

// Resolve a git checkout at a known path (the daemon's DEFAULT_ROOT, or any
// trusted path). Runs git to discover its common-dir + worktree descriptor.
async function resolveRepoFromPath(worktreePath: string): Promise<Repo | null> {
  if (!existsSync(worktreePath)) return null;
  const { stdout, code } = await runGitIn(worktreePath, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
    "--show-toplevel",
    "--git-dir",
    "--abbrev-ref",
    "HEAD",
  ]);
  if (code !== 0) return null;
  const [commonDirRaw, toplevel, gitDir, branch] = stdout.trim().split("\n");
  if (!commonDirRaw || !toplevel) return null;
  const commonDir = realpathOrSelf(commonDirRaw);
  const top = realpathOrSelf(toplevel);
  const name = gitDir?.includes("/worktrees/") ? basename(gitDir) : "";
  const rec = registerByCommonDir(commonDir, null);
  return makeRepo({
    repoId: rec.id,
    commonDir,
    worktreePath: top,
    name: rec.name ?? basename(top),
    descriptor: { name, branch: branch || null, pathHint: top },
    stale: false,
  });
}

// Resolve a registered repo by id (the browser's `?repo=<id>` selector), landing
// on its primary worktree. Stale when the repo's path is gone.
export async function resolveRepoById(repoId: string): Promise<Repo | null> {
  const rec = db.getRepoById(repoId);
  if (!rec) return null;
  if (!existsSync(rec.commonDir)) {
    return makeRepo({
      repoId: rec.id,
      commonDir: rec.commonDir,
      worktreePath: dirname(rec.commonDir),
      name: rec.name ?? basename(dirname(rec.commonDir)),
      descriptor: null,
      stale: true,
    });
  }
  const { primary } = await resolveWorktreePath(rec.commonDir, null);
  const wt = primary ?? dirname(rec.commonDir);
  return makeRepo({
    repoId: rec.id,
    commonDir: rec.commonDir,
    worktreePath: wt,
    name: rec.name ?? basename(wt),
    descriptor: null,
    stale: !primary,
  });
}

// Resolve the Repo a review's git ops must run against (id-addressed routes need
// no client hint — the row carries repo_id + worktree). Handles `git worktree
// move` (auto, by name) and removal: immutable reviews fall back to the primary
// worktree (identical result); live reviews flag stale.
export async function resolveRepoForReview(
  review: Review,
  opts: { touch?: boolean } = {},
): Promise<Repo | null> {
  const rec = db.getRepoById(review.repo_id);
  if (!rec) return null;
  const descriptor = review.worktree;

  if (!existsSync(rec.commonDir)) {
    // Repo path missing entirely — show the review shell + offer relink.
    return makeRepo({
      repoId: rec.id,
      commonDir: rec.commonDir,
      worktreePath: dirname(rec.commonDir),
      name: rec.name ?? basename(dirname(rec.commonDir)),
      descriptor,
      stale: true,
    });
  }

  const { path, primary } = await resolveWorktreePath(rec.commonDir, descriptor);
  if (path) {
    if (opts.touch !== false) db.touchRepo(rec.id); // background callers pass touch:false
    return makeRepo({
      repoId: rec.id,
      commonDir: rec.commonDir,
      worktreePath: path,
      name: rec.name ?? basename(path),
      descriptor,
      stale: false,
    });
  }

  // Worktree removed. Immutable reviews are worktree-independent → primary,
  // not stale. Live (WORKING/STAGED) reviews are bound to it → flag stale.
  const fallback = primary ?? dirname(rec.commonDir);
  return makeRepo({
    repoId: rec.id,
    commonDir: rec.commonDir,
    worktreePath: fallback,
    name: rec.name ?? basename(fallback),
    descriptor,
    stale: !isImmutableSource(review.source),
  });
}

// The realpath'd common-dir of a checkout at `path`, or null if it isn't a git
// repo. Used by relink to point a moved repo's row at its new location.
export async function commonDirOf(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  const { stdout, code } = await runGitIn(path, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  if (code !== 0) return null;
  const cd = stdout.trim().split("\n")[0];
  return cd ? realpathOrSelf(cd) : null;
}

// The daemon's fallback repo for header-less / selector-less requests.
// Resolved fresh each call (not cached): DEFAULT_ROOT's branch/worktree can
// change, and the repo can be forgotten/relinked mid-lifetime — a cached Repo
// would pin a stale branch or a dangling repo_id (FK-violating header-less
// creates). It's only the rare fallback, so the extra `git rev-parse` is fine.
export async function defaultRepo(): Promise<Repo | null> {
  return resolveRepoFromPath(DEFAULT_ROOT);
}
