import type { ArtifactVersion } from "../../shared/artifacts.ts";
import { fieldworkSeed } from "./fixture.ts";

declare const EXAMPLE_DOCUMENT_SCRIPT: string;
declare const EXAMPLE_DOCUMENT_STYLE: string;
declare const COMPONENT_FONT: string;

// Only these build-owned publications can supply executable bytes. Practice
// comments, draft storage, and mutable demo state never supply preview content.
const publications = new Map(
  (["prototype", "explainer", "brief"] as const).flatMap((scene) =>
    Object.entries(fieldworkSeed({ themes: [], themeStyles: {} }, scene).publications).map(
      ([key, publication]) => [key, { scene, publication }] as const,
    ),
  ),
);

export function examplePreview(version: ArtifactVersion, path: string) {
  const entry = publications.get(`${version.artifactId}/${version.seq}`);
  if (
    !entry ||
    path !== "index.html" ||
    entry.publication.version.contentHash !== version.contentHash ||
    entry.publication.version.kind !== version.kind
  )
    return null;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<style>@font-face{font-family:"r3 Example Sans";src:url(data:font/ttf;base64,${COMPONENT_FONT}) format("truetype");font-weight:100 900;font-display:block}
${EXAMPLE_DOCUMENT_STYLE}</style></head><body>
<div id="root" data-scene="${entry.scene}" data-version="${version.seq}"></div>
<script>${EXAMPLE_DOCUMENT_SCRIPT.replace(/<\/script/gi, "<\\/script")}</script></body></html>`;
  return { publication: entry.publication, documents: { "index.html": html }, html };
}
