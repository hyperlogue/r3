// Rendered-text projection of Markdown source — the anchor search's view of
// what the browser actually shows. A quote selected in rendered markdown is the
// DISPLAYED text: markup stripped (`code`, **em**, [link] syntax), entities
// decoded. Matching that against raw source needs edit-distance slack that
// dense markup exhausts — a mid-quote URL or a table's pipes cost more edits
// than the fuzzy budget allows, so the quote never located and the note wore
// "outdated" with nothing changed. Projecting the parsed TOKEN STREAM to the
// text markdown-it will render — with a per-character map back to source
// lines — lets those quotes match exactly, like any code quote.
//
// This module owns the ONE markdown-it instance: the parse config decides what
// the browser shows, so the projection and the renderer must share it —
// server/highlight.ts decorates this same instance with its render-only rules
// (images, doclinks, data-line tagging). Kept Shiki-free so the browser demo's
// backend mirror (web/demo/backend.ts) can import it without dragging the
// highlighter into the bundle.

import MarkdownIt from "markdown-it";
import { type ProjectedDoc, projectDoc } from "./anchor.ts";

export const md = new MarkdownIt({ html: false, linkify: true, breaks: false });
// Same hardening the client message renderer applies (web/src/markdown.ts) — a
// reviewed `.md` comes from a tree we don't trust, so it needs it at least as
// much. Scheme-required auto-linking only: fuzzy mode promotes any bare
// filename whose extension doubles as a TLD — README.md, setup.py, build.sh —
// and every bare domain in prose into a live external link that isn't in the
// file's markup.
md.linkify.set({ fuzzyLink: false, fuzzyEmail: false });

// Remote vs local resource split, shared by the render rules (highlight.ts) and
// the projection below. `data:` makes no request. (Twin: REMOTE_URL_RE in
// web/src/markdown.ts.)
export const REMOTE_URL_RE = /^(?!data:)[a-z][a-z0-9+.-]*:|^\/\//i;

export function isMarkdown(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

// Every projection a file's quotes may have been captured against, most likely
// first: a browser selection in rendered markdown quotes the displayed text —
// search that first; raw source second (agent CLI quotes, the raw-view toggle,
// and the only projection every other file kind has). Callers search them in
// order with findQuoteAcross (server/anchor.ts).
export function projectionsFor(path: string, content: string): ProjectedDoc[] {
  const raw = projectDoc(content);
  return isMarkdown(path) ? [projectRenderedMarkdown(content), raw] : [raw];
}

type Token = ReturnType<typeof md.parse>[number];

// The alt text of an image token — its children flattened to plain text, which
// is what the remote-image link rule displays (renderInlineAsText).
function inlineAltText(tok: Token): string {
  let out = "";
  for (const c of tok.children ?? []) {
    if (c.type === "image") out += inlineAltText(c);
    else if (c.content) out += c.content;
  }
  return out;
}

// Project markdown to the text the browser renders, mapping every kept
// character back to its source line (0-based, same shape as projectDoc). The
// mapping rides the token stream: block tokens carry source maps; within an
// inline run, each softbreak/hardbreak is one source newline. Inline text
// concatenates with NO invented separator ("foo`bar`baz" renders "foobarbaz");
// block edges and line breaks count as whitespace, exactly as the browser lays
// them out — and as Selection.toString() reports them.
export function projectRenderedMarkdown(source: string): ProjectedDoc {
  const lines = source.split("\n");
  let norm = "";
  const lineOf: number[] = [];
  let prevWs = true;
  // Indexed by code unit (not code point), like projectDoc — norm and lineOf
  // must stay in lockstep for windowMatch's offset math.
  const emitText = (text: string, line: number) => {
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (/\s/.test(ch)) {
        if (!prevWs) {
          norm += " ";
          lineOf.push(line);
          prevWs = true;
        }
      } else {
        norm += ch;
        lineOf.push(line);
        prevWs = false;
      }
    }
  };
  const emitBreak = (line: number) => {
    if (!prevWs) {
      norm += " ";
      lineOf.push(line);
      prevWs = true;
    }
  };
  let blockLine = 0;
  for (const tok of md.parse(source, {})) {
    if (tok.map) blockLine = tok.map[0];
    if (tok.type === "inline") {
      // A table cell's inline carries no map — the enclosing tr_open's start
      // line (the row's source line) stands in.
      let line = tok.map?.[0] ?? blockLine;
      for (const c of tok.children ?? []) {
        if (c.type === "softbreak" || c.type === "hardbreak") {
          line++;
          emitBreak(line);
          continue;
        }
        if (c.type === "image") {
          // Mirror the renderer: a remote image shows as a link carrying its
          // alt text (or its URL); a local <img>'s alt is not selectable text.
          const src = c.attrGet("src") ?? "";
          if (REMOTE_URL_RE.test(src)) emitText(inlineAltText(c) || src, line);
          continue;
        }
        // text (entities/escapes decoded), code_inline, linkified URLs; the
        // structural children (link/em/strong open+close) carry no content.
        if (c.content) emitText(c.content, line);
      }
      emitBreak(line);
      continue;
    }
    if (tok.type === "fence" || tok.type === "code_block") {
      // Fence content starts on the line after the opening ```; an indented
      // code block's content starts on its own first line. Content arrives
      // dedented, which the whitespace-insensitive search never notices.
      const start = (tok.map?.[0] ?? blockLine) + (tok.type === "fence" ? 1 : 0);
      const body = tok.content.split("\n");
      if (body[body.length - 1] === "") body.pop();
      body.forEach((l, i) => {
        emitText(l, start + i);
        emitBreak(start + i);
      });
      continue;
    }
    // Every other top-level token is block structure — an edge between
    // rendered texts (paragraphs, list items, table cells).
    emitBreak(blockLine);
  }
  return { lines, norm, lineOf };
}
