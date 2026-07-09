// Precise sub-block highlighting for rendered markdown via the CSS Custom
// Highlight API (developer.mozilla.org/docs/Web/API/CSS_Custom_Highlight_API).
//
// Rendered markdown carries only block-granular data-line-start/end, so a
// line-range highlight can paint no smaller than a whole <p>/<ul>/<table> —
// much larger than the text a feedback actually points at. Instead we locate the
// feedback's `quote` (the anchor of record) inside its block and
// highlight exactly that text. Ranges highlight without mutating the DOM, so
// this coexists with the server HTML injected via dangerouslySetInnerHTML.

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

// Register `ranges` under `name`, replacing any previous set; empty unregisters.
// A no-op where the API is unavailable — callers fall back to a block-level mark.
export function setHighlightRanges(name: string, ranges: Range[]): void {
  const reg = registry();
  if (!reg) return;
  if (ranges.length === 0) reg.delete(name);
  else reg.set(name, new Highlight(...ranges));
}

function isWs(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f";
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

// A DOM Range covering `quote` within `root`, matched whitespace-insensitively
// across text-node / inline-element boundaries. null when the quote isn't there
// (an outdated anchor) — the caller falls back to a block-level mark.
export function rangeForQuote(root: Element, quote: string): Range | null {
  const q = quote.replace(/\s+/g, " ").trim();
  if (!q) return null;
  const { norm, nodes, offsets } = mapText(root);
  const idx = norm.indexOf(q);
  if (idx < 0) return null;
  const end = idx + q.length - 1;
  if (end >= nodes.length) return null;
  const range = document.createRange();
  range.setStart(nodes[idx], offsets[idx]);
  range.setEnd(nodes[end], offsets[end] + 1);
  return range;
}
