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

// Keep the original file headers (quoted names, object IDs, modes, rename/copy
// evidence). Trimming changes only hunk context, never file metadata or EOF.
function renderUnifiedDiffFile(f: DiffFileChange, headers: string[]): string[] {
  const out = [...headers];
  for (const line of f.lines) {
    if (line.type === "hunk") out.push(line.text);
    else {
      out.push(`${line.type === "add" ? "+" : line.type === "del" ? "-" : " "}${line.text}`);
      if (line.noNewline) out.push("\\ No newline at end of file");
    }
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
    const hunkStart = seg.search(/^@@/m);
    if (hunkStart < 0) return seg;
    const headers = seg.slice(0, hunkStart).split("\n");
    if (headers.at(-1) === "") headers.pop();
    changed = true;
    return renderUnifiedDiffFile({ ...files[0], lines: trimmed }, headers).join("\n");
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
  let remainingOld = 0;
  let remainingNew = 0;
  let sawFileHeaders = false;
  const fresh = (): DiffFileChange => ({
    oldPath: null,
    newPath: null,
    path: "",
    status: "modified",
    binary: false,
    additions: 0,
    deletions: 0,
    lines: [],
  });

  const push = () => {
    if (cur) files.push(cur);
  };

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith("diff --git ")) {
      push();
      inHunk = false;
      sawFileHeaders = false;
      remainingOld = remainingNew = 0;
      cur = fresh();
      const m = gitHeaderPaths(line);
      if (m) {
        cur.oldPath = m[0];
        cur.newPath = m[1];
        cur.path = m[1];
      }
      continue;
    }
    // Ordinary diff -u output has paired ---/+++ headers without diff --git.
    // Only recognize them outside a declared hunk; SQL/Lua content beginning
    // with ---/+++ is still a removed/added source line.
    if (
      line.startsWith("--- ") &&
      lines[index + 1]?.startsWith("+++ ") &&
      (!inHunk || (remainingOld === 0 && remainingNew === 0))
    ) {
      if (!cur || inHunk || sawFileHeaders) {
        push();
        cur = fresh();
      }
      inHunk = false;
      sawFileHeaders = true;
    }
    if (!cur) continue;
    if (line === "\\ No newline at end of file") {
      const previous = cur.lines.at(-1);
      if (previous && previous.type !== "hunk") previous.noNewline = true;
      continue;
    }

    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (m) {
        oldNo = Number(m[1]);
        newNo = Number(m[3]);
        remainingOld = Number(m[2] ?? "1");
        remainingNew = Number(m[4] ?? "1");
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
        if (p !== "/dev/null") {
          cur.oldPath = p.replace(/^a\//, "");
          if (!cur.path) cur.path = cur.oldPath;
        } else cur.status = "added";
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
      remainingNew--;
      cur.additions++;
      cur.lines.push({
        type: "add",
        oldLine: null,
        newLine: newNo++,
        html: "",
        text: line.slice(1),
      });
    } else if (line.startsWith("-")) {
      remainingOld--;
      cur.deletions++;
      cur.lines.push({
        type: "del",
        oldLine: oldNo++,
        newLine: null,
        html: "",
        text: line.slice(1),
      });
    } else if (line.startsWith(" ") || line === "") {
      remainingOld--;
      remainingNew--;
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
