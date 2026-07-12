// Client-side Markdown for feedback bodies + replies. Messages are stored as
// plain text (the HTTP contract carries raw text, edited inline and created
// optimistically in the browser), so we render them to safe HTML here rather
// than shipping HTML from the server the way file `.md` rendering does — a
// server round-trip per keystroke-edit / optimistic card would be far clumsier.
//
// `html:false` means raw HTML in a message is escaped, not injected, so the
// output is XSS-safe to hand to dangerouslySetInnerHTML. Two extras:
//   - external links get target=_blank + rel=noopener (a bare in-SPA nav would
//     blow away the app);
//   - an `@path:Lx-y` token (the agent's code-reference syntax) becomes a
//     clickable `.r3-ref` jump anchor carrying the file + line range in data-*
//     attributes. Resolution against a version (a diff round / snapshot) is the
//     React click handler's job — this stays version-agnostic.

import MarkdownIt from "markdown-it";

const md = new MarkdownIt({
  html: false,
  // Auto-link bare URLs (safe markdown convenience). Our @ref rule runs during
  // inline tokenization, before linkify's text-token pass, so a ref is already
  // its own token and linkify never sees it.
  linkify: true,
  // A lone newline becomes <br>, matching the whitespace-pre-wrap feel messages
  // had before — agent replies rely on single-newline line breaks reading as breaks.
  breaks: true,
});

// The `@path:Lx[-y]` reference token (matches the agent-authored syntax; see the
// CLI guide). Path is a run of path-ish characters; the line range is required so
// a bare "@name" never linkifies. Anchored at the start of the remaining source.
const REF_RE = /^@([A-Za-z0-9._~+\-/]+):L(\d+)(?:-(\d+))?/;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Inline rule: consume an `@path:Lx-y` token and emit an `r3ref` token carrying
// the parsed file + line range. Placed before `emphasis` so a path containing `_`
// isn't chewed up as emphasis first.
md.inline.ruler.before("emphasis", "r3ref", (state, silent) => {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x40 /* @ */) return false;
  // Require a boundary before `@` so we don't grab the tail of an email or an
  // `@`-mention embedded in a word.
  if (start > 0 && /[A-Za-z0-9)]/.test(state.src[start - 1])) return false;
  const m = REF_RE.exec(state.src.slice(start));
  if (!m) return false;
  if (!silent) {
    const token = state.push("r3ref", "", 0);
    token.content = m[0];
    token.meta = { file: m[1], start: m[2], end: m[3] ?? m[2] };
  }
  state.pos += m[0].length;
  return true;
});

md.renderer.rules.r3ref = (tokens, idx) => {
  const t = tokens[idx];
  const { file, start, end } = t.meta as { file: string; start: string; end: string };
  return (
    `<a class="r3-ref" data-r3-ref-file="${escapeHtml(file)}"` +
    ` data-r3-ref-start="${start}" data-r3-ref-end="${end}"` +
    ` title="Jump to ${escapeHtml(file)}:L${start}${end !== start ? `-${end}` : ""}">` +
    `${escapeHtml(t.content)}</a>`
  );
};

// External links open in a new tab so a click never navigates the SPA away.
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  tokens[idx].attrSet("target", "_blank");
  tokens[idx].attrSet("rel", "noopener noreferrer");
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// Render a message body to safe HTML. Full block markdown (lists, code fences,
// blockquotes, tables, headings) — the caller drops it into a `.r3-markdown`
// container and trims the outer block margins for the compact card context.
export function renderMessageHtml(source: string): string {
  return md.render(source);
}

// A jump reference parsed off a clicked `.r3-ref` anchor. `lineEnd` falls back to
// `lineStart` for a single-line ref.
export interface MessageRef {
  file: string;
  lineStart: number;
  lineEnd: number;
}

// Read the ref a click landed on, if any: walk up to the nearest `.r3-ref`
// anchor and pull its data-* attributes. null when the click wasn't on a ref.
export function refFromEvent(target: EventTarget | null): MessageRef | null {
  const el = target instanceof Element ? target.closest("a.r3-ref") : null;
  if (!el) return null;
  const file = el.getAttribute("data-r3-ref-file");
  const start = Number(el.getAttribute("data-r3-ref-start"));
  if (!file || !Number.isFinite(start)) return null;
  const end = Number(el.getAttribute("data-r3-ref-end"));
  return { file, lineStart: start, lineEnd: Number.isFinite(end) ? end : start };
}
