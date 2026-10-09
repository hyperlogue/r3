import type {
  Artifact,
  ArtifactDocumentTarget,
  ArtifactKind,
  ArtifactReferenceContext,
  ArtifactState,
} from "./artifacts.ts";

export interface ArtifactSearchOptions {
  q: string;
  state?: ArtifactState;
  kind?: ArtifactKind;
  project?: string;
  attention?: boolean;
  history?: "latest" | "all";
  type?: "all" | "content" | "conversation";
  limit?: number;
  offset?: number;
}

export type ArtifactSearchCategory = "artifact" | "summary" | "content" | "discussions" | "comment";

export interface ArtifactSearchMatch {
  id: string;
  artifactId: string;
  category: ArtifactSearchCategory;
  versionSeq: number | null;
  path: string | null;
  discussionId: string | null;
  commentId: string | null;
  context: ArtifactReferenceContext;
  target: ArtifactDocumentTarget | null;
  snippet: string;
}

export interface ArtifactSearchResponse {
  matches: ArtifactSearchMatch[];
  artifacts: Artifact[];
  counts: { all: number; content: number; conversation: number };
  total: number;
  nextOffset: number | null;
  // Files excluded because they exceed the source limit, are binary, or have
  // invalid UTF-8. HTML artifacts search entrypoint text, never companion code.
  skippedFiles: number;
}

export const SEARCH_FILE_BYTES = 4 * 1024 * 1024;
export const SEARCH_QUERY_LENGTH = 256;

// A query is a conjunction of Unicode word prefixes, not executable FTS syntax.
export function artifactSearchTerms(query: string): string[] {
  return [...new Set(query.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
}

export function artifactSearchParams(options: ArtifactSearchOptions): URLSearchParams {
  const params = new URLSearchParams({ q: options.q });
  for (const [key, value] of Object.entries(options))
    if (value !== undefined && key !== "q") params.set(key, String(value));
  return params;
}

export function searchTextMatches(text: string, terms: string[]): boolean {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms.length > 0 && terms.every((term) => words.some((word) => word.startsWith(term)));
}

export function searchMatchOffset(text: string, terms: string[]): number {
  for (const match of text.matchAll(/[\p{L}\p{N}]+/gu))
    if (terms.some((term) => match[0].toLowerCase().startsWith(term))) return match.index;
  return 0;
}

export function searchSnippet(text: string, terms: string[]): string {
  const offset = searchMatchOffset(text, terms);
  const start = Math.max(0, offset - 70);
  const end = Math.min(text.length, start + 260);
  return `${start ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

// Source and sparse-patch results keep native line coordinates. Rendered text
// is located as text in the rendered document, never mapped back to its source.
export function searchMatchTarget(
  target: ArtifactDocumentTarget | null,
  text: string,
  terms: string[],
): ArtifactDocumentTarget | null {
  if (!target) return null;
  if (target.kind === "media") return target;
  const offset = searchMatchOffset(text, terms);
  if (target.kind === "rendered") {
    const start = Math.max(text.lastIndexOf("\n", offset - 1) + 1, offset - 40);
    const lineEnd = text.indexOf("\n", offset);
    const end = Math.min(lineEnd < 0 ? text.length : lineEnd, offset + 180);
    const quote = text.slice(start, end).trim();
    return { ...target, locator: quote ? { selector: "body", quote } : null };
  }
  const before = text.slice(0, offset);
  const line = (target.locator?.start ?? 1) + before.split("\n").length - 1;
  const start = before.lastIndexOf("\n") + 1;
  const end = text.indexOf("\n", offset);
  const quote = text.slice(start, end < 0 ? undefined : end).slice(0, 2048);
  const locator = { start: line, end: line, quote };
  return target.kind === "source"
    ? { ...target, locator }
    : { ...target, locator: { ...locator, side: target.locator?.side ?? "new" } };
}
