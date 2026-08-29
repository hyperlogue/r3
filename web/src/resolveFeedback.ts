// Place a files-review feedback into a snapshot/round diff by quote (line
// numbers don't agree). Unchanged/added lands on the new side, deleted on the old.

import type { DiffFileChange, DiffSide, Feedback } from "./types.ts";

export interface Placement {
  file: string;
  side: DiffSide | null;
  lineStart: number;
  lineEnd: number;
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

interface Row {
  line: number;
  // Normalized once here rather than per search: `locate` compares this against
  // every quote it places, so re-normalizing made a pass over a review's
  // feedback cost one regex per line PER note.
  text: string;
}

interface FileRows {
  newRows: Row[];
  oldRows: Row[];
}

// A diff's rows, split by side and normalized, under every path a feedback
// might name the file by. Built once per diff and reused for every placement:
// the diff changes when the version on screen does, while the feedback list
// churns on every reply, resolve and live echo.
export interface DiffIndex {
  files: Map<string, FileRows>;
}

export function indexDiff(files: DiffFileChange[]): DiffIndex {
  const byPath = new Map<string, FileRows>();
  for (const f of files) {
    const rows: FileRows = { newRows: [], oldRows: [] };
    for (const ln of f.lines) {
      if (ln.type === "hunk") continue;
      const text = norm(ln.text);
      if (ln.newLine != null) rows.newRows.push({ line: ln.newLine, text });
      if (ln.oldLine != null) rows.oldRows.push({ line: ln.oldLine, text });
    }
    // First file to claim a name keeps it, which is the file-order scan this
    // replaced: a rename's old path can't be stolen by a later file's new one.
    for (const p of [f.path, f.oldPath, f.newPath]) {
      if (p && !byPath.has(p)) byPath.set(p, rows);
    }
  }
  return { files: byPath };
}

// Find the quote's first line (whitespace-insensitively) among `rows` and return
// the covered line range. Mirrors the server's quote search (anchor.ts / the
// reply-pin check): a first-line substring match, biased to the occurrence nearest
// `hint` so a repeated line (a heading, `});`) resolves to the right place. The
// range extends across the quote's own line count but only while rows stay
// contiguous on this side, so it never smears across a hunk gap.
function locate(rows: Row[], quote: string, hint: number | null): [number, number] | null {
  const first = norm(quote.split("\n", 1)[0]);
  if (!first) return null;
  const hits: number[] = [];
  for (let i = 0; i < rows.length; i++) if (rows[i].text.includes(first)) hits.push(i);
  if (hits.length === 0) return null;
  let idx = hits[0];
  if (hint != null) {
    let best = Number.POSITIVE_INFINITY;
    for (const h of hits) {
      const d = Math.abs(rows[h].line - hint);
      if (d < best) {
        best = d;
        idx = h;
      }
    }
  }
  const start = rows[idx].line;
  // A trailing newline isn't an extra line; count the quote's real lines.
  const qLines = quote.replace(/\n+$/, "").split("\n").length;
  let end = start;
  for (let k = 1; k < qLines && idx + k < rows.length; k++) {
    if (rows[idx + k].line !== rows[idx + k - 1].line + 1) break; // hunk gap — stop
    end = rows[idx + k].line;
  }
  return [start, end];
}

// Locate one feedback in an indexed diff. Returns null when the feedback names no
// file in the diff or its quote isn't found on either side (it's listed in the
// panel but not highlighted in this view). The feedback's live `line_start` biases
// the search toward the right occurrence (exact on the new side when to=Current).
export function placeInDiff(
  index: DiffIndex,
  fb: Pick<Feedback, "file" | "quote" | "line_start">,
): Placement | null {
  if (!fb.quote || !fb.file) return null;
  const rows = index.files.get(fb.file);
  if (!rows) return null;
  const inNew = locate(rows.newRows, fb.quote, fb.line_start);
  if (inNew) return { file: fb.file, side: "new", lineStart: inNew[0], lineEnd: inNew[1] };
  const inOld = locate(rows.oldRows, fb.quote, fb.line_start);
  if (inOld) return { file: fb.file, side: "old", lineStart: inOld[0], lineEnd: inOld[1] };
  return null;
}
