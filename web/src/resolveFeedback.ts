// Placing feedback in a snapshot-diff view by quote. A files review's
// feedback stays anchored to the *live* file (its stored line number tracks live
// content), so it can't be positioned in a snapshot→snapshot diff by line number —
// the diff renumbers lines and shows two sides. Instead we locate the feedback's
// quote in the diff rows: unchanged/added text lands on the new side, deleted text
// on the old side (prefer new, like the diff renderer). The client already has the
// diff rows' text (DiffLine.text), so this needs no extra fetch and keeps the diff
// endpoint feedback-agnostic + cacheable.

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
  text: string;
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
  for (let i = 0; i < rows.length; i++) if (norm(rows[i].text).includes(first)) hits.push(i);
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

// Locate one feedback in a derived diff. Returns null when the feedback names no
// file in the diff or its quote isn't found on either side (it's listed in the
// panel but not highlighted in this view). The feedback's live `line_start` biases
// the search toward the right occurrence (exact on the new side when to=Current).
export function placeInDiff(
  files: DiffFileChange[],
  fb: Pick<Feedback, "file" | "quote" | "line_start">,
): Placement | null {
  if (!fb.quote || !fb.file) return null;
  const f = files.find((x) => x.path === fb.file || x.oldPath === fb.file || x.newPath === fb.file);
  if (!f) return null;
  const newRows: Row[] = [];
  const oldRows: Row[] = [];
  for (const ln of f.lines) {
    if (ln.type === "hunk") continue;
    if (ln.newLine != null) newRows.push({ line: ln.newLine, text: ln.text });
    if (ln.oldLine != null) oldRows.push({ line: ln.oldLine, text: ln.text });
  }
  const inNew = locate(newRows, fb.quote, fb.line_start);
  if (inNew) return { file: fb.file, side: "new", lineStart: inNew[0], lineEnd: inNew[1] };
  const inOld = locate(oldRows, fb.quote, fb.line_start);
  if (inOld) return { file: fb.file, side: "old", lineStart: inOld[0], lineEnd: inOld[1] };
  return null;
}
