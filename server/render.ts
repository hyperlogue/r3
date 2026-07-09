// Render one file at a ref for `kind:'files'` reviews and the diff "expand
// hidden lines" path. Markdown renders to block HTML
// with source-line mapping; code renders to Shiki-highlighted per-line rows.

import type { RenderedFile, RenderedFileLine } from "../shared/types.ts";
import { blobSha, readContentAt } from "./git.ts";
import {
  escapeHtml,
  highlightToLines,
  isMarkdown,
  langForPath,
  renderMarkdown,
} from "./highlight.ts";
import type { Repo } from "./repo.ts";

export async function renderFile(
  repo: Repo,
  path: string,
  ref: string,
  theme?: string,
): Promise<RenderedFile | null> {
  const content = await readContentAt(repo, path, ref);
  if (content == null) return null;
  return renderContent(path, content, ref, theme);
}

// Render already-in-hand content (a snapshot's stored file text) with
// the same code/markdown pipeline as renderFile — no worktree read. `ref` is a
// display label only.
export async function renderContent(
  path: string,
  content: string,
  ref: string,
  theme?: string,
): Promise<RenderedFile> {
  const sha = await blobSha(content);
  // Match the derived-diff's end-of-file convention (textdiff.toDiffLines): a
  // single trailing newline is the EOF marker, not an empty final line, so
  // "a\nb\n" renders as 2 lines — the same count the snapshot/diff view shows.
  // Without this the blob view carried a phantom trailing blank line and
  // disagreed with the diff on the last line number. Empty content is left as its
  // one (empty) line — an empty file never appears in a diff, so there's nothing
  // to stay parity with, and rendering zero rows would look like a failed load.
  // html (from highlightToLines) keeps its own count; indexing html[i] over the
  // (shorter) srcLines stays in range.
  const srcLines = content.split("\n");
  if (content.length > 0 && content.endsWith("\n")) srcLines.pop();

  if (isMarkdown(path)) {
    const lines: RenderedFileLine[] = srcLines.map((text, i) => ({
      lineNo: i + 1,
      html: escapeHtml(text),
      text,
    }));
    return {
      path,
      ref,
      kind: "markdown",
      lang: "markdown",
      sha,
      lines,
      markdownHtml: renderMarkdown(content),
    };
  }

  const lang = langForPath(path);
  const html = await highlightToLines(content, lang, sha, theme);
  const lines: RenderedFileLine[] = srcLines.map((text, i) => ({
    lineNo: i + 1,
    html: html[i] ?? escapeHtml(text),
    text,
  }));
  return { path, ref, kind: "code", lang, sha, lines, markdownHtml: null };
}
