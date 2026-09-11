import type { ArtifactSource } from "../shared/artifacts.ts";
import type { ArtifactStore } from "./artifacts.ts";
import { escapeHtml, highlightToLines, langForPath } from "./highlight.ts";

const MAX_SOURCE_BYTES = 4 * 1024 * 1024;

// Highlight published input only. Rendered Markdown/HTML lives in the isolated
// preview and never arrives as executable markup inside this source response.
export async function artifactSource(
  store: ArtifactStore,
  id: string,
  seq: number,
  path: string,
  theme?: string,
): Promise<ArtifactSource> {
  const file = store.file(id, seq, path);
  const result: ArtifactSource = {
    artifactId: id,
    versionSeq: seq,
    path,
    hash: file.hash,
    byteLength: file.byteLength,
    mediaType: file.mediaType,
    kind: "text",
    language: null,
    lines: [],
  };
  if (file.byteLength > MAX_SOURCE_BYTES) return { ...result, kind: "oversize" };
  const bytes = await store.readFile(id, seq, path);
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (source.includes("\0")) return { ...result, kind: "binary" };
  } catch {
    return { ...result, kind: "binary" };
  }
  source = source.replaceAll("\r\n", "\n");
  const language = langForPath(path);
  const highlighted = await highlightToLines(source, language, file.hash, theme);
  const lines = source.split("\n");
  if (source.endsWith("\n")) lines.pop();
  return {
    ...result,
    language,
    lines: lines.map((text, i) => ({
      lineNo: i + 1,
      text,
      html: highlighted[i] ?? escapeHtml(text),
    })),
  };
}
