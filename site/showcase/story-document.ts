import type { PreviewBootstrap } from "../../shared/preview-protocol.ts";
import { previewHead } from "./component-document.ts";

declare const STORY_DOCUMENTS: Record<string, Record<string, string>>;
export function storyDocument(config: PreviewBootstrap) {
  const html = STORY_DOCUMENTS[`${config.artifactId}/${config.versionSeq}`]?.[config.entryPath];
  if (!html) throw new Error("Missing published story document");
  const dark = document.documentElement.classList.contains("dark");
  return html
    .replace("<head>", `<head>${previewHead(config)}`)
    .replace(
      "</head>",
      `<style>:root{color-scheme:${dark ? "dark" : "light"};font-family:"r3 Example Sans",sans-serif;font-size:15px}body{padding:24px 36px;background:${dark ? "#191b1f" : "#fff"};color:${dark ? "#e2e4e9" : "#232731"}}h1{margin-top:0;font-size:28px}h2{margin-top:24px;font-size:20px}</style></head>`,
    );
}
