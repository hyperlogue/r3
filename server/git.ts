// Git access + a unified-diff parser (the highest-value port from
// difit, re-implemented). Everything shells out to `git` via Bun.spawn. The v2
// daemon is multi-repo, so git ops run in a per-request `Repo`'s
// worktree (`repo.git()` = `cwd: repo.worktreePath`) and validate paths against
// it (`repo.safePath`), rather than a module-global ROOT. `runGitIn` is the
// low-level primitive the Repo factory builds on (server/repo.ts).

import { readFileSync } from "node:fs";
import type {
  DiffFileChange,
  DiffResult,
  GitLogEntry,
  GitRef,
  GitStatus,
  GitStatusEntry,
  GitTreeEntry,
} from "../shared/types.ts";
import { escapeHtml, highlightToLines, langForPath } from "./highlight.ts";
import { realpathWithin } from "./paths.ts";
import type { Repo } from "./repo.ts";
import { scratchDir, scratchSafePath } from "./scratch.ts";
import { rehunk } from "./textdiff.ts";

// git can block indefinitely through no fault of ours: a common-dir on a stale
// NFS/sshfs mount, a core.fsmonitor hook that never returns, a GIT_ASKPASS
// pointing at a GUI prompt. One such call is permanent damage — the watcher's
// `refreshing` guard is cleared only in a `finally`, so a call that never
// settles stops it establishing any new watch for the daemon's whole lifetime.
const GIT_TIMEOUT_MS = 30_000;

// Low-level: run git in a given cwd. The Repo factory wraps this as `repo.git()`.
export async function runGitIn(
  cwd: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  const read = Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  // `timeout` kills git itself, but the reads are awaited before `exited`, so a
  // forked helper (pager, credential, git-remote-*) that inherited the pipe and
  // outlived it would still hold us. Race the reads too.
  const got = await Promise.race([read, Bun.sleep(GIT_TIMEOUT_MS + 1_000).then(() => null)]);
  if (!got) {
    proc.kill(9);
    // Non-zero is already the universal failure path for every caller.
    return { stdout: "", stderr: `git ${args.join(" ")} timed out`, code: 124 };
  }
  const code = await proc.exited;
  return { stdout: got[0], stderr: got[1], code };
}

const isSentinel = (r: GitRef): r is "WORKING" | "STAGED" => r === "WORKING" || r === "STAGED";

// A ref beginning with "-" is parsed by git as an option, not a tree-ish —
// argument injection (e.g. `--output=<file>` makes git diff/show write a file).
// Sentinels and real refs/shas never start with "-", so reject anything that
// does. Callers must validate refs that originate from untrusted requests.
export function isSafeRef(ref: GitRef): boolean {
  return isSentinel(ref) || !ref.startsWith("-");
}

// Content sha: the highlight cache key, and the `code_sha` recorded on a feedback
// anchor (stored only — staleness is surfaced via `anchor`, see shared/types.ts).
export async function blobSha(content: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(content);
  return hasher.digest("hex");
}

// Read a file's content at a given ref, within a repo's worktree. WORKING reads
// disk, STAGED reads the index, anything else is `git show <ref>:<path>`. Returns
// null if absent.
export async function readContentAt(repo: Repo, path: string, ref: GitRef): Promise<string | null> {
  if (!isSafeRef(ref)) return null;
  // SCRATCH content lives in the daemon's scratch dir, not the worktree — resolve
  // against that root (still strict: no absolute, no `..`) and read from disk.
  if (ref === "SCRATCH") {
    const safe = scratchSafePath(path);
    if (!safe) return null;
    // Symlink-escape guard: safePath is lexical, so a symlink inside the scratch
    // dir pointing outside it would pass — resolve links and confirm the real
    // target is still within the scratch root before reading (see paths.ts).
    if (!realpathWithin(scratchDir(), safe)) return null;
    try {
      return readFileSync(safe, "utf8");
    } catch {
      return null;
    }
  }
  const safe = repo.safePath(path);
  if (!safe) return null;
  if (ref === "WORKING") {
    // Same symlink-escape guard, against the review's worktree root: an in-repo
    // symlink to a file outside the worktree must not be followed out. A pinned
    // ref/STAGED read below goes through `git show`, which resolves blobs from
    // the object store (no filesystem symlink to follow), so it needs no guard.
    if (!realpathWithin(repo.worktreePath, safe)) return null;
    try {
      return readFileSync(safe, "utf8");
    } catch {
      return null;
    }
  }
  const spec = ref === "STAGED" ? `:${path}` : `${ref}:${path}`;
  const { stdout, code } = await repo.git(["show", spec]);
  return code === 0 ? stdout : null;
}

// ---- status ----

export async function gitStatus(repo: Repo): Promise<GitStatus> {
  const out = await repo.gitText(["status", "--porcelain=v2", "--branch", "-z"]);
  const parts = out.split("\0");
  let branch: string | null = null;
  let ahead = 0;
  let behind = 0;
  const entries: GitStatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith("# branch.head ")) branch = line.slice("# branch.head ".length);
    else if (line.startsWith("# branch.ab ")) {
      const m = line.match(/\+(\d+) -(\d+)/);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line[0] === "1") {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>  (path = rest of record)
      const fields = line.split(" ");
      entries.push(mkEntry(fields.slice(8).join(" "), fields[1]));
    } else if (line[0] === "2") {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <Xscore> <path>\0<origPath>
      const fields = line.split(" ");
      entries.push(mkEntry(fields.slice(9).join(" "), fields[1]));
      i++; // consume the NUL-separated original path
    } else if (line[0] === "?") {
      entries.push({
        path: line.slice(2),
        index: "?",
        worktree: "?",
        staged: false,
        unstaged: true,
        untracked: true,
      });
    }
  }
  return { branch, ahead, behind, entries };
}

function mkEntry(path: string, xy: string): GitStatusEntry {
  const index = xy[0];
  const worktree = xy[1];
  return {
    path,
    index,
    worktree,
    staged: index !== ".",
    unstaged: worktree !== ".",
    untracked: false,
  };
}

// ---- log ----

const LOG_SEP = "\x1f";
const LOG_FMT = ["%H", "%h", "%s", "%an", "%aI", "%D"].join(LOG_SEP);

export async function gitLog(repo: Repo, limit = 50, cursor = 0): Promise<GitLogEntry[]> {
  const out = await repo.gitText([
    "log",
    `--max-count=${limit}`,
    `--skip=${cursor}`,
    `--pretty=format:${LOG_FMT}`,
  ]);
  if (!out.trim()) return [];
  return out.split("\n").map((line) => {
    const [sha, shortSha, subject, author, date, refs] = line.split(LOG_SEP);
    return { sha, shortSha, subject, author, date, refs: refs ?? "" };
  });
}

// ---- tree ----

export async function gitTree(repo: Repo, ref: GitRef, path?: string): Promise<GitTreeEntry[]> {
  if (!isSafeRef(ref)) return [];
  const realRef = isSentinel(ref) ? "HEAD" : ref;
  const args = ["ls-tree", "-r", "--name-only", "-z", realRef];
  if (path) {
    const safe = repo.safePath(path);
    if (!safe) return [];
    args.push("--", path);
  }
  const out = await repo.gitText(args);
  return out
    .split("\0")
    .filter(Boolean)
    .map((p) => ({ path: p, name: p.split("/").pop() ?? p, type: "blob" as const }));
}

// ---- diff ----

function diffArgs(
  base: GitRef,
  head: GitRef,
  opts: { ignoreWhitespace?: boolean; context?: number },
) {
  const args = ["diff", "--no-color", "--find-renames", `--unified=${opts.context ?? 3}`];
  if (opts.ignoreWhitespace) args.push("--ignore-all-space");
  if (head === "WORKING") args.push(base === "STAGED" ? "" : base);
  else if (head === "STAGED") args.push("--cached", base === "HEAD" ? "" : base);
  else args.push(base, head);
  return args.filter(Boolean);
}

export async function getDiff(
  repo: Repo,
  base: GitRef,
  head: GitRef,
  opts: { ignoreWhitespace?: boolean; context?: number; theme?: string } = {},
): Promise<DiffResult> {
  if (!isSafeRef(base) || !isSafeRef(head)) throw new Error("unsafe ref");
  const raw = await repo.gitText(diffArgs(base, head, opts));
  const files = parseUnifiedDiff(raw);
  await highlightFiles(repo, files, base, head, opts.theme);
  return { base, head, files };
}

// How much context a round is CAPTURED with. Effectively whole-file: git merges
// hunks whose context overlaps, so a wide -U doesn't duplicate anything and the
// stored ceiling is the touched files' own size. Rounds are immutable and git is
// never consulted again at render, so whatever isn't captured here can never be
// expanded later — this number is the one chance to hold it.
export const WIDE_CONTEXT = 2000;

// …but "the file's own size" is the wrong price for a one-line edit to a
// lockfile. A file whose wide entry exceeds MAX_ROUND_FILE_BYTES is re-emitted at
// TRIM_CONTEXT instead, so the pathological cases stay bounded while ordinary
// source files keep full expandability. Measured on this repo: capturing wide
// costs ~5.8× the stored bytes of -U3, and this cap brings it to ~3.0× while
// only clipping generated files and the largest few components (which still get
// 25 lines each way — 8× what -U3 gave).
export const MAX_ROUND_FILE_BYTES = 64 * 1024;
export const TRIM_CONTEXT = 25;

// Re-emit one parsed file change as unified-diff text. Only used on the trim
// path, so it must round-trip through parseUnifiedDiff — it does, but it is NOT
// byte-faithful to git: `index` lines, mode changes and the
// "\ No newline at end of file" marker are dropped, because parseUnifiedDiff
// doesn't retain them (git.ts) and nothing downstream reads them. That's why the
// trim splices per file and leaves untouched files as git's own bytes.
// Emits a line list (no trailing newline) so it splices back in exactly where a
// segment came out — splitFileSegments works in lines and the caller re-joins.
function renderUnifiedDiffFile(f: DiffFileChange): string[] {
  const a = f.oldPath ?? f.path;
  const b = f.newPath ?? f.path;
  const out = [`diff --git a/${a} b/${b}`];
  if (f.status === "added") out.push("new file mode 100644");
  else if (f.status === "deleted") out.push("deleted file mode 100644");
  else if (f.status === "renamed") out.push(`rename from ${a}`, `rename to ${b}`);
  out.push(f.status === "added" ? "--- /dev/null" : `--- a/${a}`);
  out.push(f.status === "deleted" ? "+++ /dev/null" : `+++ b/${b}`);
  for (const ln of f.lines) {
    if (ln.type === "hunk") out.push(ln.text);
    else out.push(`${ln.type === "add" ? "+" : ln.type === "del" ? "-" : " "}${ln.text}`);
  }
  return out;
}

// Split a raw patch into its per-file segments, keeping each one's original
// bytes. Everything before the first `diff --git ` (git's own preamble, if any)
// rides along with nothing to trim.
function splitFileSegments(raw: string): string[] {
  const lines = raw.split("\n");
  const segments: string[] = [];
  let cur: string[] = [];
  for (const line of lines) {
    if (line.startsWith("diff --git ") && cur.length) {
      segments.push(cur.join("\n"));
      cur = [];
    }
    cur.push(line);
  }
  if (cur.length) segments.push(cur.join("\n"));
  return segments;
}

// Bring a wide capture back under control per file: any segment bigger than
// MAX_ROUND_FILE_BYTES is re-hunked to TRIM_CONTEXT and re-emitted; every other
// segment keeps git's exact bytes. Splicing per file (rather than re-emitting
// the whole patch) is what keeps the lossy re-emit confined to the files that
// actually needed trimming.
export function trimOversizedFiles(
  raw: string,
  context = TRIM_CONTEXT,
  cap = MAX_ROUND_FILE_BYTES,
): string {
  if (!raw.includes("diff --git ")) return raw;
  let changed = false;
  const out = splitFileSegments(raw).map((seg) => {
    if (Buffer.byteLength(seg, "utf8") <= cap) return seg;
    const files = parseUnifiedDiff(seg);
    if (files.length !== 1) return seg; // not a single clean file segment — leave it
    const trimmed = rehunk(files[0].lines, context);
    if (trimmed === files[0].lines) return seg; // nothing dropped — keep git's bytes
    changed = true;
    return renderUnifiedDiffFile({ ...files[0], lines: trimmed }).join("\n");
  });
  if (!changed) return raw;
  // A re-emitted final segment drops the patch's trailing newline (the original
  // carried it as a trailing empty line that the re-emit doesn't reproduce).
  // Nothing downstream reads it, but a stored patch should still look like one.
  const joined = out.join("\n");
  return raw.endsWith("\n") && !joined.endsWith("\n") ? `${joined}\n` : joined;
}

// Snapshot a diff as raw patch text — the create-time source of a stored diff
// round. One git run, then the refs are never consulted again. A
// WORKING head also synthesizes added-file entries for untracked (non-ignored)
// files, which `git diff` omits: new files an agent just wrote are usually
// exactly what the review is about.
export async function snapshotDiff(repo: Repo, base: GitRef, head: GitRef): Promise<string> {
  if (!isSafeRef(base) || !isSafeRef(head)) throw new Error("unsafe ref");
  // Capture WIDE, render narrow. The round is immutable and these refs are never
  // consulted again, so context not taken here can never be recovered — a piped
  // diff, an amended commit or a relinked repo would all fail to re-read it. What
  // this holds is exactly what "expand context" can later reveal.
  let raw = await repo.gitText(diffArgs(base, head, { context: WIDE_CONTEXT }));
  if (head === "WORKING") {
    const { stdout } = await repo.git(["ls-files", "--others", "--exclude-standard", "-z"]);
    for (const path of stdout.split("\0").filter(Boolean)) {
      const content = await readContentAt(repo, path, "WORKING");
      if (content == null || content.includes("\0")) continue; // unreadable/binary
      raw += syntheticAddPatch(path, content);
    }
  }
  // Per-file trim so one tiny edit to a lockfile doesn't store the lockfile. The
  // synthetic adds above are all-additions, so there's no context in them to
  // drop — they're unaffected either way.
  return trimOversizedFiles(raw);
}

// A minimal added-file patch for `path`, matching what `git diff` emits for a
// staged new file — parseUnifiedDiff reads it back as status:'added'.
function syntheticAddPatch(path: string, content: string): string {
  const header = `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n`;
  const body = content.endsWith("\n") ? content.slice(0, -1) : content;
  // A truly empty (0-byte) or single-newline file has no content to add, but git
  // still records it as a new file. Emit the header with an empty hunk
  // (`@@ -0,0 +0,0 @@`, no body) rather than "" — the old "" dropped exactly the
  // files people create empty (.gitkeep, __init__.py) from a --working round,
  // despite this function's whole point. parseUnifiedDiff reads the `new file
  // mode` line back as status:'added'.
  if (body === "") return `${header}@@ -0,0 +0,0 @@\n`;
  const lines = body.split("\n");
  const noEol = content.endsWith("\n") ? "" : "\n\\ No newline at end of file";
  return `${header}@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join("\n")}${noEol}\n`;
}

// Parse `git diff` text into per-file structured changes. Hunk header rows are
// kept inline (type 'hunk') so the renderer can show the @@ context.
export function parseUnifiedDiff(raw: string): DiffFileChange[] {
  const files: DiffFileChange[] = [];
  const lines = raw.split("\n");
  // The patch's own trailing newline, not a body row — it has to go before an
  // empty line can be read as content (below), or it becomes a phantom row.
  if (lines[lines.length - 1] === "") lines.pop();
  let cur: DiffFileChange | null = null;
  // Once a hunk header is seen, every +/-/space line is hunk *content*, not a
  // file header — otherwise a deleted `-- comment` (Lua/SQL) or added `++ x`
  // line is misread as a `---`/`+++` header, dropping the row and corrupting
  // line numbers + paths. Header lines only appear before the first `@@`.
  let inHunk = false;
  let oldNo = 0;
  let newNo = 0;

  const push = () => {
    if (cur) files.push(cur);
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      push();
      inHunk = false;
      cur = {
        oldPath: null,
        newPath: null,
        path: "",
        status: "modified",
        binary: false,
        additions: 0,
        deletions: 0,
        lines: [],
      };
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (m) {
        cur.oldPath = m[1];
        cur.newPath = m[2];
        cur.path = m[2];
      }
      continue;
    }
    if (!cur) continue;

    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[2]);
        inHunk = true;
        cur.lines.push({ type: "hunk", oldLine: null, newLine: null, html: "", text: line });
      }
      continue;
    }

    if (!inHunk) {
      // File-header region (between `diff --git` and the first hunk).
      if (line.startsWith("new file mode")) cur.status = "added";
      else if (line.startsWith("deleted file mode")) cur.status = "deleted";
      else if (line.startsWith("rename from ")) {
        cur.status = "renamed";
        cur.oldPath = line.slice("rename from ".length);
      } else if (line.startsWith("rename to ")) {
        cur.newPath = line.slice("rename to ".length);
        cur.path = cur.newPath;
      } else if (line.startsWith("Binary files")) cur.binary = true;
      else if (line.startsWith("--- ")) {
        const p = line.slice(4);
        if (p !== "/dev/null") cur.oldPath = p.replace(/^a\//, "");
        else cur.status = "added";
      } else if (line.startsWith("+++ ")) {
        const p = line.slice(4);
        if (p !== "/dev/null") {
          cur.newPath = p.replace(/^b\//, "");
          cur.path = cur.newPath;
        } else cur.status = "deleted";
      }
      continue;
    }

    // Hunk-content region: classify by the first character only.
    if (line.startsWith("+")) {
      cur.additions++;
      cur.lines.push({
        type: "add",
        oldLine: null,
        newLine: newNo++,
        html: "",
        text: line.slice(1),
      });
    } else if (line.startsWith("-")) {
      cur.deletions++;
      cur.lines.push({
        type: "del",
        oldLine: oldNo++,
        newLine: null,
        html: "",
        text: line.slice(1),
      });
    } else if (line.startsWith(" ") || line === "") {
      // `""` is an empty context line whose marker space was stripped in
      // transit (editors, mail, chat). Skipping it would drop the row AND leave
      // oldNo/newNo un-advanced, shifting every later line in the round. git's
      // own apply.c has the same case; `"".slice(1)` is `""`, so the text is
      // right and renderUnifiedDiffFile re-emits it as `" "`.
      cur.lines.push({
        type: "context",
        oldLine: oldNo++,
        newLine: newNo++,
        html: "",
        text: line.slice(1),
      });
    }
    // "\ No newline at end of file" is ignored.
  }
  push();
  return files;
}

// Fill each diff line's `html` from Shiki-highlighted full-file blobs (so
// multi-line constructs colorize correctly), mapping by old/new line number.
async function highlightFiles(
  repo: Repo,
  files: DiffFileChange[],
  base: GitRef,
  head: GitRef,
  theme?: string,
): Promise<void> {
  await Promise.all(
    files.map(async (f) => {
      if (f.binary) return;
      const lang = langForPath(f.path);
      const oldContent =
        f.status === "added" ? null : await readContentAt(repo, f.oldPath ?? f.path, base);
      const newContent =
        f.status === "deleted" ? null : await readContentAt(repo, f.newPath ?? f.path, head);
      // Cache the per-line highlight by content sha so repeated diffs (and the
      // blob route) don't re-tokenize the same file.
      const oldHl =
        oldContent != null
          ? await highlightToLines(oldContent, lang, await blobSha(oldContent), theme)
          : null;
      const newHl =
        newContent != null
          ? await highlightToLines(newContent, lang, await blobSha(newContent), theme)
          : null;
      for (const ln of f.lines) {
        if (ln.type === "hunk") continue;
        if (ln.newLine != null && newHl && newHl[ln.newLine - 1] != null)
          ln.html = newHl[ln.newLine - 1];
        else if (ln.oldLine != null && oldHl && oldHl[ln.oldLine - 1] != null)
          ln.html = oldHl[ln.oldLine - 1];
        else ln.html = escapeHtml(ln.text);
      }
    }),
  );
}

// Resolve a possibly-abbreviated ref to a full sha for stable anchoring.
export async function resolveRev(repo: Repo, ref: GitRef): Promise<string> {
  if (isSentinel(ref) || !isSafeRef(ref)) return ref;
  const { stdout, code } = await repo.git(["rev-parse", ref]);
  return code === 0 ? stdout.trim() : ref;
}
