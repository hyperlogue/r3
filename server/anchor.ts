// Keeping feedback from orphaning. The anchor of record is the
// *quote*; the line number is only a hint. On render / file-change we search the
// current file for the quote (whitespace-insensitive, preferring near the old
// line) and relocate the feedback. If the quote is gone, the feedback is marked
// `outdated` rather than silently mis-pointing.
//
// A quote captured in the browser comes from *rendered* text: selecting inside a
// Markdown block yields the prose with source markup stripped (`` `code` ``,
// *em*, `[links]`), so a verbatim substring search against the raw file misses
// even when the text is plainly there. When the exact search fails we fall back
// to an edit-distance search for the closest window (`fuzzyFind`), which tolerates
// the handful of markup characters the renderer dropped. Anchoring rendered
// Markdown onto its source is inherently lossy — this closes the common cases
// (inline code, emphasis) without pretending to solve it in general.

interface AnchorMatch {
  lineStart: number; // 1-based
  lineEnd: number; // 1-based
  text: string; // the matched span's current text
}

// Collapse all runs of whitespace to a single space; used so re-formatting
// (indentation, wrapping) doesn't orphan a quote. Exported so patches.ts's
// reply-pin check normalizes identically — the two must stay in lockstep.
export function normalizeWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// Build a whitespace-normalized projection of the document plus a map from each
// normalized-char index back to its source line (0-based).
function project(lines: string[]): { norm: string; lineOf: number[] } {
  let norm = "";
  const lineOf: number[] = [];
  let prevWasSpace = true; // treat start as space so leading ws is dropped
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    // a newline acts as whitespace between lines
    for (let c = 0; c < raw.length; c++) {
      const ch = raw[c];
      if (/\s/.test(ch)) {
        if (!prevWasSpace) {
          norm += " ";
          lineOf.push(li);
          prevWasSpace = true;
        }
      } else {
        norm += ch;
        lineOf.push(li);
        prevWasSpace = false;
      }
    }
    // line boundary = whitespace
    if (!prevWasSpace) {
      norm += " ";
      lineOf.push(li);
      prevWasSpace = true;
    }
  }
  return { norm, lineOf };
}

// Max fraction of the quote we tolerate as edits in the fuzzy fallback, with a
// small absolute floor so a mostly-markup short quote (e.g. a bare `` `code` ``
// span, +2 backticks) still relocates. Only reached after the exact search fails.
const FUZZY_MAX_RATIO = 0.25;
const FUZZY_MIN_QUOTE = 4;
// Bound the O(m·n) DP so a pathologically large file can't stall a render; past
// this the quote just stays outdated, as it would have before fuzzy matching.
const FUZZY_MAX_CELLS = 20_000_000;

// A file projected once for anchoring: raw lines (for the returned text) plus the
// whitespace-normalized string + its char->line map (for searching). Building this
// is O(file size); reuse it across all feedback on the same file (see reviews.ts).
export interface ProjectedDoc {
  lines: string[];
  norm: string;
  lineOf: number[];
}

export function projectDoc(content: string): ProjectedDoc {
  const lines = splitLines(content);
  const { norm, lineOf } = project(lines);
  return { lines, norm, lineOf };
}

// Find `quote` in a projected file, whitespace-insensitively, preferring the
// occurrence nearest the hint — the caller's *range* (`hintLine`..`hintEndLine`,
// 1-based), not just its first line: an occurrence anywhere inside the hinted
// span is equally "at" the hint, so a repeated phrase resolves to the copy the
// note was actually left on rather than to whichever copy happens to sit closer
// to the span's first line. Matters most for a rendered-Markdown anchor, whose
// hint is the whole enclosing block. Omitting `hintEndLine` collapses the range
// to the single line and behaves exactly as before. Returns the matched 1-based
// line range, or null.
export function findQuote(
  doc: ProjectedDoc,
  quote: string,
  hintLine?: number | null,
  hintEndLine?: number | null,
): AnchorMatch | null {
  const target = normalizeWs(quote);
  if (!target) return null;
  const { norm, lineOf, lines } = doc;

  // Exact fast path: collect all verbatim occurrences, pick the one nearest the
  // hint. Handles unchanged code/plain prose without paying for the DP below.
  const offsets: number[] = [];
  let from = 0;
  for (;;) {
    const idx = norm.indexOf(target, from);
    if (idx === -1) break;
    offsets.push(idx);
    from = idx + 1;
  }
  if (offsets.length > 0) {
    const best = nearestOffset(offsets, lineOf, hintLine, hintEndLine);
    // A verbatim copy inside the hinted span is the anchor — settle immediately.
    if (hintLine == null || hintDistance(lineOf[best], hintLine, hintEndLine) === 0)
      return windowMatch(best, best + target.length, lines, lineOf);
    // Every verbatim copy sits OUTSIDE the span the note was left in. A
    // rendered-Markdown quote loses its markup, so the copy *at* the note can
    // fail the exact search (backticks, emphasis, link syntax) while a plain
    // near-duplicate elsewhere passes — and anchoring there silently mis-points,
    // the one thing this module must never do. Before settling for the far copy,
    // fuzzy-search just the hinted span: a within-threshold hit there is the
    // likelier anchor. Nothing inside → the far copy stands (a real relocation,
    // e.g. the text moved and the hint is stale).
    const near = fuzzyFindNearHint(norm, target, lineOf, hintLine, hintEndLine);
    if (near) return windowMatch(near.start, near.end, lines, lineOf);
    return windowMatch(best, best + target.length, lines, lineOf);
  }

  // No verbatim match — fall back to the fuzzy search (rendered-Markdown markup,
  // minor edits). The hinted span gets first claim here too: the global search
  // minimizes edits and only tie-breaks by hint, so the copy the note was left
  // on — costing extra edits for its stripped markup — lost to any near-
  // duplicate elsewhere (one case-changed word beats two `**`). Only when
  // nothing within threshold sits at the hint does the global search decide.
  // Bail rather than mis-point if it, too, comes up empty.
  if (hintLine != null) {
    const near = fuzzyFindNearHint(norm, target, lineOf, hintLine, hintEndLine);
    if (near) return windowMatch(near.start, near.end, lines, lineOf);
  }
  const hit = fuzzyFind(norm, target, lineOf, hintLine, hintEndLine);
  if (!hit) return null;
  return windowMatch(hit.start, hit.end, lines, lineOf);
}

// How far a (0-based) line sits from the hinted span: zero anywhere inside it,
// else the gap to the nearer end. The one place "near the hint" is defined, so
// the exact and fuzzy searches rank candidates identically.
function hintDistance(
  line0: number,
  hintLine?: number | null,
  hintEndLine?: number | null,
): number {
  if (hintLine == null) return 0;
  const lo = hintLine - 1;
  const hi = Math.max(lo, (hintEndLine ?? hintLine) - 1);
  return line0 < lo ? lo - line0 : line0 > hi ? line0 - hi : 0;
}

// Among exact-match offsets, the one whose start line is closest to the hint.
function nearestOffset(
  offsets: number[],
  lineOf: number[],
  hintLine?: number | null,
  hintEndLine?: number | null,
): number {
  if (hintLine == null) return offsets[0];
  let best = offsets[0];
  let bestDist = Infinity;
  for (const off of offsets) {
    const dist = hintDistance(lineOf[off], hintLine, hintEndLine);
    if (dist < bestDist) {
      bestDist = dist;
      best = off;
    }
  }
  return best;
}

// Map a [startOff, endOff) span of the normalized projection back to a 1-based
// inclusive source line range, carrying the current source text of those lines.
function windowMatch(
  startOff: number,
  endOff: number,
  lines: string[],
  lineOf: number[],
): AnchorMatch {
  const startLine = lineOf[startOff];
  const endLine = lineOf[Math.max(startOff, endOff - 1)] ?? startLine;
  return {
    lineStart: startLine + 1,
    lineEnd: endLine + 1,
    text: lines.slice(startLine, endLine + 1).join("\n"),
  };
}

interface FuzzyHit {
  start: number; // inclusive offset into the normalized projection
  end: number; // exclusive
}

// First index whose lineOf value is >= line (lineOf is nondecreasing).
function lowerBound(lineOf: number[], line: number): number {
  let lo = 0;
  let hi = lineOf.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (lineOf[mid] < line) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// Fuzzy-search only the projection slice covering the hinted lines (plus a
// quote-sized margin on each side so a match may straddle the span's edge).
// Used by findQuote's exact path when every verbatim copy lies outside the hint:
// the slice keeps the DP tiny, and a hit is accepted only if it actually touches
// the hinted lines — a margin-only hit would be the far-copy problem again.
function fuzzyFindNearHint(
  norm: string,
  target: string,
  lineOf: number[],
  hintLine: number,
  hintEndLine?: number | null,
): FuzzyHit | null {
  const lo0 = hintLine - 1;
  const hi0 = Math.max(lo0, (hintEndLine ?? hintLine) - 1);
  let lo = lowerBound(lineOf, lo0);
  let hi = lowerBound(lineOf, hi0 + 1);
  if (lo >= hi) return null;
  lo = Math.max(0, lo - target.length);
  hi = Math.min(norm.length, hi + target.length);
  const hit = fuzzyFind(norm.slice(lo, hi), target, lineOf.slice(lo, hi), hintLine, hintEndLine);
  if (!hit) return null;
  const startLine = lineOf[hit.start + lo];
  const endLine = lineOf[hit.end + lo - 1] ?? startLine;
  if (endLine < lo0 || startLine > hi0) return null;
  return { start: hit.start + lo, end: hit.end + lo };
}

// Cheap pre-filter for fuzzyFind: does the quote's longest alphanumeric token
// still appear verbatim in the file? A token (word between markup/punctuation) is
// unaffected by whitespace normalization, so a plain substring test suffices. A
// quote with no token >= 5 chars has no distinctive anchor to test — let the
// (short, cheap) DP decide.
function hasAnchorToken(norm: string, target: string): boolean {
  let longest = "";
  for (const tok of target.split(/[^\p{L}\p{N}]+/u)) {
    if (tok.length > longest.length) longest = tok;
  }
  return longest.length < 5 || norm.includes(longest);
}

// Approximate-substring search: find the window of `norm` with the smallest edit
// distance to `target`, accept it if that distance is within a length-scaled
// threshold, and prefer the window nearest the hint line. Free-start DP (row 0
// all zeros) lets the match begin anywhere; `start[j]` tracks where the best
// window ending at `j` began so we can recover its span.
function fuzzyFind(
  norm: string,
  target: string,
  lineOf: number[],
  hintLine?: number | null,
  hintEndLine?: number | null,
): FuzzyHit | null {
  const m = target.length;
  const n = norm.length;
  if (m < FUZZY_MIN_QUOTE || n === 0) return null;
  // Fail fast without the O(m·n) DP when the quote is genuinely gone (a real
  // orphan, e.g. deleted code). A true fuzzy match keeps the quote's most
  // distinctive word verbatim — dropped Markdown markup sits *between* words, and
  // a couple of edits can't touch every token — so if even the longest token is
  // absent, no window can land within threshold. This keeps a review full of
  // orphaned notes as cheap as the old exact-only path.
  if (!hasAnchorToken(norm, target)) return null;
  if (m * n > FUZZY_MAX_CELLS) return null;
  const maxDist = Math.max(2, Math.floor(m * FUZZY_MAX_RATIO));

  let prev = new Int32Array(n + 1);
  let prevStart = new Int32Array(n + 1);
  for (let j = 0; j <= n; j++) prevStart[j] = j; // row 0: empty match starts at j
  let cur = new Int32Array(n + 1);
  let curStart = new Int32Array(n + 1);

  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    curStart[0] = 0;
    const tc = target.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cost = tc === norm.charCodeAt(j - 1) ? 0 : 1;
      let v = prev[j - 1] + cost; // substitute/match: consume both
      let st = prevStart[j - 1];
      const up = prev[j] + 1; // delete a quote char
      if (up < v) {
        v = up;
        st = prevStart[j];
      }
      const left = cur[j - 1] + 1; // skip a source char (dropped markup)
      if (left < v) {
        v = left;
        st = curStart[j - 1];
      }
      cur[j] = v;
      curStart[j] = st;
    }
    const t1 = prev;
    prev = cur;
    cur = t1;
    const t2 = prevStart;
    prevStart = curStart;
    curStart = t2;
  }

  // `prev` now holds the final row: prev[j] = distance for a window ending at j.
  let bestDist = Infinity;
  for (let j = 1; j <= n; j++) if (prev[j] < bestDist) bestDist = prev[j];
  if (bestDist > maxDist) return null;

  let hit: FuzzyHit | null = null;
  let bestHintDist = Infinity;
  for (let j = 1; j <= n; j++) {
    if (prev[j] !== bestDist) continue;
    const start = prevStart[j];
    if (j <= start) continue; // empty window
    const hd = hintDistance(lineOf[start] ?? 0, hintLine, hintEndLine);
    if (hd < bestHintDist) {
      bestHintDist = hd;
      hit = { start, end: j };
    }
  }
  return hit;
}

function splitLines(content: string): string[] {
  return content.split("\n");
}
