// Pure patch parsing and capture trimming. No repository or filesystem reads.
import type { DiffFileChange } from "../shared/types.ts";
import { decodeGitPath, gitHeaderPaths } from "./git-path.ts";
import { rehunk } from "./textdiff.ts";

export async function blobSha(content: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(content);
  return hasher.digest("hex");
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
      const m = gitHeaderPaths(line);
      if (m) {
        cur.oldPath = m[0];
        cur.newPath = m[1];
        cur.path = m[1];
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
        cur.oldPath = decodeGitPath(line.slice("rename from ".length));
      } else if (line.startsWith("rename to ")) {
        cur.newPath = decodeGitPath(line.slice("rename to ".length));
        cur.path = cur.newPath;
      } else if (line.startsWith("Binary files") || line === "GIT binary patch") cur.binary = true;
      else if (line.startsWith("--- ")) {
        const p = decodeGitPath(line.slice(4), true);
        if (p !== "/dev/null") cur.oldPath = p.replace(/^a\//, "");
        else cur.status = "added";
      } else if (line.startsWith("+++ ")) {
        const p = decodeGitPath(line.slice(4), true);
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
