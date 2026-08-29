// Quote ranges in rendered markdown (CSS Custom Highlight). Quote is the
// anchor of record; ranges don't mutate the DOM so they coexist with
// dangerouslySetInnerHTML.

// Registry names paired with the ::highlight() rules in main.css.
export const HL_FEEDBACK = "r3-feedback";
export const HL_ACTIVE = "r3-active";

// The TS DOM lib types HighlightRegistry with only `forEach`; the runtime object
// is maplike. Narrow to the methods we use.
type HighlightMap = {
  set(name: string, hl: Highlight): void;
  delete(name: string): boolean;
};

function registry(): HighlightMap | null {
  if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") {
    return null;
  }
  return CSS.highlights as unknown as HighlightMap;
}

export function supportsHighlights(): boolean {
  return registry() !== null;
}

// What each name currently holds. The region pass re-derives its ranges on every
// content mutation and almost always lands on the same ones, so remember the set
// and skip a re-register: building a Highlight and swapping it in invalidates the
// paint for nothing. The stored Ranges are the very objects the registry holds,
// so a range that drifted (a live Range moves with the DOM under it) drifted on
// both sides and still compares equal to a freshly derived one — which is right,
// the registry is already painting where the new range points.
const registered = new Map<string, Range[]>();

function sameRanges(a: Range[], b: Range[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (
      a[i].startContainer !== b[i].startContainer ||
      a[i].startOffset !== b[i].startOffset ||
      a[i].endContainer !== b[i].endContainer ||
      a[i].endOffset !== b[i].endOffset
    ) {
      return false;
    }
  }
  return true;
}

// Register `ranges` under `name`, replacing any previous set; empty unregisters.
// A no-op where the API is unavailable — callers fall back to a block-level mark.
export function setHighlightRanges(name: string, ranges: Range[]): void {
  const reg = registry();
  if (!reg) return;
  const prev = registered.get(name);
  // No entry = we've never written this name, so never assume it's already empty.
  if (prev && sameRanges(prev, ranges)) return;
  if (ranges.length === 0) reg.delete(name);
  else reg.set(name, new Highlight(...ranges));
  registered.set(name, ranges.slice());
}

// MUST be the same character class the quote side collapses with (/\s+/ in
// rangeForQuote, normalizeWs on the server): JS \s includes U+00A0 and the
// other Unicode spaces, so an `&nbsp;` in the source — a real non-breaking
// space in the rendered text — normalizes identically on both sides. A
// narrower list here left the map holding U+00A0 while the quote held a plain
// space, and such a quote could never match from either direction.
function isWs(ch: string): boolean {
  return /\s/.test(ch);
}

interface Mapped {
  // Whitespace-collapsed text of everything under the root.
  norm: string;
  // norm[i] came from text node nodes[i] at character offset offsets[i].
  nodes: Text[];
  offsets: number[];
}

// Build a whitespace-collapsed string of all text under `root`, keeping a map
// from each normalized character back to its (text node, offset) so a substring
// match can be turned into a DOM Range. Runs of whitespace collapse to one space
// so a stored quote (verbatim source, with newlines/indentation) matches the
// reflowed rendered HTML — mirrors the server's relocation in anchor.ts.
function mapText(root: Element): Mapped {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let norm = "";
  const nodes: Text[] = [];
  const offsets: number[] = [];
  let prevWs = false;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    const s = t.data;
    for (let i = 0; i < s.length; i++) {
      if (isWs(s[i])) {
        if (prevWs) continue;
        prevWs = true;
        norm += " ";
      } else {
        prevWs = false;
        norm += s[i];
      }
      nodes.push(t);
      offsets.push(i);
    }
  }
  return { norm, nodes, offsets };
}

// mapText walks every character of a block, and one block is asked for several
// quotes (every region resolving to that <ul>/<table>) and re-asked on every
// render/mutation pass — so keep the last walk per element. `textContent` is the
// key: a native subtree read that changes iff the mapping would, and cheap next
// to rebuilding two per-character arrays. The one thing it can't see is the same
// text in brand-new nodes (React re-setting innerHTML), which would leave the
// cached Text refs detached and any Range into them painting nothing — so check
// the endpoints are still in the document before trusting the entry. Weak, so an
// entry dies with the block it maps.
const mapCache = new WeakMap<Element, { key: string; mapped: Mapped }>();

function attached(m: Mapped): boolean {
  const last = m.nodes.length - 1;
  return last < 0 || (m.nodes[0].isConnected && m.nodes[last].isConnected);
}

function mappedFor(root: Element): Mapped {
  const key = root.textContent ?? "";
  const hit = mapCache.get(root);
  if (hit && hit.key === key && attached(hit.mapped)) return hit.mapped;
  const mapped = mapText(root);
  mapCache.set(root, { key, mapped });
  return mapped;
}

// Which copy of a repeated quote to paint: the stored anchor's relative
// position inside its block (0..1), derived from the block's data-line span.
// The rendered text carries no source lines, so relative position is the only
// bridge back to the copy the server anchored — exact for a block holding one
// copy, and it tie-breaks toward the right copy when the block repeats the
// phrase across lines. A single-line block can't distinguish its copies
// (undefined → first occurrence, which is also what the server stored).
export function quotePos(el: Element, lineStart: number, lineEnd: number): number | undefined {
  const bs = Number(el.getAttribute("data-line-start"));
  const be = Number(el.getAttribute("data-line-end") ?? bs);
  if (!Number.isFinite(bs) || be <= bs) return undefined;
  const mid = ((lineStart + lineEnd) / 2 - bs + 0.5) / (be - bs + 1);
  return Math.min(1, Math.max(0, mid));
}

// A DOM Range covering `quote` within `root`, matched whitespace-insensitively
// across text-node / inline-element boundaries. null when the quote isn't there
// (an outdated anchor) — the caller falls back to a block-level mark. When the
// block contains the quote more than once, `pos` (see quotePos) picks the
// occurrence nearest the stored anchor instead of blindly the first.
export function rangeForQuote(root: Element, quote: string, pos?: number): Range | null {
  const q = quote.replace(/\s+/g, " ").trim();
  if (!q) return null;
  const { norm, nodes, offsets } = mappedFor(root);
  let idx = norm.indexOf(q);
  if (idx < 0) return null;
  if (pos != null) {
    const span = Math.max(1, norm.length - q.length);
    let bestD = Math.abs(idx / span - pos);
    for (let at = norm.indexOf(q, idx + 1); at >= 0; at = norm.indexOf(q, at + 1)) {
      const d = Math.abs(at / span - pos);
      if (d < bestD) {
        bestD = d;
        idx = at;
      }
    }
  }
  const end = idx + q.length - 1;
  if (end >= nodes.length) return null;
  const range = document.createRange();
  range.setStart(nodes[idx], offsets[idx]);
  range.setEnd(nodes[end], offsets[end] + 1);
  return range;
}
