// Stored patch rendering depends only on captured rows, never on git refs or a repo.
import { type DiffFileChange, type DiffLine, MAX_CONTEXT_ROWS } from "../shared/types.ts";
import { ArtifactError, requireArtifactPath } from "./artifact-validation.ts";
import { blobSha, parseUnifiedDiff } from "./git.ts";
import { escapeHtml, highlightToLines, langForPath } from "./highlight.ts";
import { rehunk } from "./textdiff.ts";

export function validateStoredPatch(raw: string): DiffFileChange[] {
  const files = parseUnifiedDiff(raw);
  if (!files.length) throw new ArtifactError("Publication must contain a unified diff");
  const paths = new Set<string>();
  for (const file of files) {
    requireArtifactPath(file.path);
    if (file.oldPath) requireArtifactPath(file.oldPath);
    if (file.newPath) requireArtifactPath(file.newPath);
    if (paths.has(file.path)) throw new ArtifactError("Patch repeats a file");
    paths.add(file.path);
    let remainingOld = 0;
    let remainingNew = 0;
    let oldEnd = 0;
    let newEnd = 0;
    for (const row of file.lines) {
      if (row.type === "hunk") {
        if (remainingOld || remainingNew)
          throw new ArtifactError("Patch contains a truncated hunk");
        const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(row.text)!;
        const [oldStart, oldCount, newStart, newCount] = [
          header[1],
          header[2] ?? "1",
          header[3],
          header[4] ?? "1",
        ].map(Number);
        if (
          ![oldStart, oldCount, newStart, newCount, oldStart + oldCount, newStart + newCount].every(
            Number.isSafeInteger,
          ) ||
          oldStart < oldEnd ||
          newStart < newEnd ||
          (oldCount > 0 && oldStart < 1) ||
          (newCount > 0 && newStart < 1)
        ) {
          throw new ArtifactError("Patch contains invalid or overlapping hunk ranges");
        }
        oldEnd = oldStart + oldCount;
        newEnd = newStart + newCount;
        remainingOld = oldCount;
        remainingNew = newCount;
      } else {
        if (row.oldLine !== null) remainingOld--;
        if (row.newLine !== null) remainingNew--;
        if (remainingOld < 0 || remainingNew < 0)
          throw new ArtifactError("Patch hunk exceeds its declared range");
      }
    }
    if (remainingOld || remainingNew) throw new ArtifactError("Patch contains a truncated hunk");
  }
  // The display parser tolerates legacy input. New publications cannot quietly
  // lose malformed hunk lines that parser would skip.
  let inHunk = false;
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      if (!/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line))
        throw new ArtifactError("Invalid patch hunk header");
      inHunk = true;
    } else if (
      inHunk &&
      line !== "" &&
      !/^[ +-]/.test(line) &&
      line !== "\\ No newline at end of file"
    ) {
      throw new ArtifactError("Invalid patch hunk row");
    }
  }
  if (
    !files.some((file) => file.lines.length || file.binary || file.status !== "modified") &&
    !/^old mode \d+\nnew mode \d+$/m.test(raw)
  ) {
    throw new ArtifactError("Patch contains no changes");
  }
  return files;
}

export async function renderStoredPatch(raw: string, theme?: string): Promise<DiffFileChange[]> {
  const files = parseUnifiedDiff(raw);
  for (const file of files) file.lines = rehunk(file.lines, 3, { markExpandable: true });
  await highlightPatchFiles(files, theme);
  return files;
}

// Context expansion can expose only contiguous, unchanged rows retained by this
// publication. Missing rows are never reconstructed from a local checkout.
export async function storedPatchContext(
  raw: string,
  path: string,
  start: number,
  end: number,
  theme?: string,
): Promise<DiffLine[] | null> {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 1 ||
    end < start ||
    end - start >= MAX_CONTEXT_ROWS
  )
    return null;
  const file = parseUnifiedDiff(raw).find((file) => file.path === path || file.oldPath === path);
  if (!file) return null;
  const rows = file.lines.filter(
    (row) =>
      row.type === "context" && row.newLine !== null && row.newLine >= start && row.newLine <= end,
  );
  if (rows.length !== end - start + 1 || rows.some((row, i) => row.newLine !== start + i))
    return null;
  await highlightPatchFiles([file], theme);
  return rows;
}

// Highlight a parsed patch from its own hunk text. The originating refs may not
// exist anywhere (a piped diff, a rebased-away commit), so unlike the live-diff
// path there's no full file to read: reconstruct each side's visible text from
// the rows that carry that side's line numbers and highlight those pseudo-files.
// Multi-line constructs that span outside a hunk degrade gracefully (Shiki just
// sees less context). Cached by content sha like every other highlight.
export async function highlightPatchFiles(files: DiffFileChange[], theme?: string): Promise<void> {
  await Promise.all(
    files.map(async (f) => {
      if (f.binary) return;
      const lang = langForPath(f.path);
      const oldRows: number[] = [];
      const newRows: number[] = [];
      f.lines.forEach((ln, i) => {
        if (ln.type === "hunk") return;
        if (ln.oldLine != null) oldRows.push(i);
        if (ln.newLine != null) newRows.push(i);
      });
      const hl = async (rowIdx: number[]) => {
        if (!rowIdx.length) return null;
        const content = rowIdx.map((i) => f.lines[i].text).join("\n");
        return highlightToLines(content, lang, await blobSha(content), theme);
      };
      const [oldHl, newHl] = await Promise.all([hl(oldRows), hl(newRows)]);
      // Map back by row order (the k-th new-side row is the k-th pseudo-file
      // line), preferring the new side like the live-diff renderer.
      const bySide = (rowIdx: number[], html: string[] | null) => {
        if (!html) return;
        rowIdx.forEach((rowI, k) => {
          const ln = f.lines[rowI];
          if (!ln.html) ln.html = html[k] ?? escapeHtml(ln.text);
        });
      };
      bySide(newRows, newHl);
      bySide(oldRows, oldHl);
      for (const ln of f.lines) {
        if (ln.type !== "hunk" && !ln.html) ln.html = escapeHtml(ln.text);
      }
    }),
  );
}
