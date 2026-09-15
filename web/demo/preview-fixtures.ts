import type { ArtifactVersion } from "../../shared/artifacts.ts";
import { ARTIFACT_DEMO_PREVIEWS, ARTIFACT_DEMO_SEED } from "./artifact-fixtures.gen.ts";
import { publicationKey } from "./artifact-model.ts";

const publications = new Map(
  [
    ...Object.values(ARTIFACT_DEMO_SEED.publications),
    ...Object.values(ARTIFACT_DEMO_SEED.pending),
  ].map((item) => [publicationKey(item.version.artifactId, item.version.seq), item]),
);

// Executable documents and assets come only from build fixtures. Browser storage
// supplies conversations and selected version identity, never executable bytes.
export function bundledPreview(version: ArtifactVersion, path: string) {
  const key = publicationKey(version.artifactId, version.seq);
  const publication = publications.get(key);
  const preview = ARTIFACT_DEMO_PREVIEWS[key];
  if (
    !publication ||
    !preview ||
    preview.contentHash !== version.contentHash ||
    publication.version.kind !== version.kind ||
    !Object.hasOwn(preview.documents, path)
  )
    return null;
  return { publication, documents: preview.documents, html: preview.documents[path] };
}

// Resolve only canonical members of this publication. Absolute URLs, query
// strings, and paths escaping the publication have no demo resource authority.
const unsafeText = (text: string) => [...text].some((c) => c.charCodeAt(0) <= 32 || c === "\\");

export function demoReference(
  from: string,
  reference: string,
): { path: string; route: string } | null {
  if (!reference || unsafeText(reference) || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(reference))
    return null;
  const [rawPath, ...hash] = reference.split("#");
  if (rawPath.includes("?")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    return null;
  }
  if (unsafeText(decoded) || /[?#]/.test(decoded) || decoded.startsWith("/")) return null;
  const parts = rawPath ? from.split("/").slice(0, -1) : from.split("/");
  if (rawPath)
    for (const part of decoded.split("/")) {
      if (part === "." || !part) continue;
      if (part === "..") {
        if (!parts.length) return null;
        parts.pop();
      } else parts.push(part);
    }
  return { path: parts.join("/"), route: `#${hash.join("#")}` };
}
