import type { ArtifactActor, ArtifactKind } from "../shared/artifacts.ts";
import {
  ArtifactError,
  canonicalJson,
  jsonObject,
  optionalText,
  requireActor,
  requireArtifactPath,
  requireMediaType,
  requireObject,
  requireSequence,
  requireString,
} from "./artifact-validation.ts";
import { type BlobStore, hashBytes, type StoredBlob } from "./blobs.ts";
import { validateStoredPatch } from "./patch-content.ts";

export const PUBLICATION_LIMITS = {
  files: 10_000,
  fileBytes: 64 * 1024 * 1024,
  totalBytes: 128 * 1024 * 1024,
  patchBytes: 10 * 1024 * 1024,
  markdownBytes: 4 * 1024 * 1024,
} as const;

interface DecodedFile {
  path: string;
  mediaType: string;
  bytes: Buffer;
}

export interface ValidatedPublication {
  listen: boolean;
  expectedSeq: number;
  publicationKey: string;
  actor: ArtifactActor;
  label: string | null;
  summary: string | null;
  provenance: Record<string, unknown>;
  kind: ArtifactKind;
  contentHash: string;
  entrypoint: "index.html" | null;
  patch: string | null;
  files: DecodedFile[];
}

export interface PreparedFile extends StoredBlob {
  path: string;
  mediaType: string;
  rendered: (StoredBlob & { revision: string }) | null;
}

export type DocumentRenderer = {
  (source: string, path: string): Promise<{ html: string; revision: string }>;
  // Declaring a revision promises deterministic output for source + path.
  // Unversioned adapters still render normally, without reusable results.
  readonly revision?: string;
};

function decodeFile(value: unknown): DecodedFile {
  const file = requireObject(value, "File");
  const path = requireArtifactPath(file.path);
  const mediaType = requireMediaType(file.mediaType);
  if (typeof file.base64 !== "string") throw new ArtifactError("File bytes must be base64 text");
  if (file.base64.length > Math.ceil(PUBLICATION_LIMITS.fileBytes / 3) * 4) {
    throw new ArtifactError("File exceeds the publication size limit", 413);
  }
  // Buffer's decoder is deliberately forgiving. The wire contract is not:
  // reject truncation, skipped garbage and noncanonical padding bits.
  const bytes = Buffer.from(file.base64, "base64");
  if (bytes.toString("base64") !== file.base64)
    throw new ArtifactError("Invalid base64 file bytes");
  if (bytes.byteLength > PUBLICATION_LIMITS.fileBytes) {
    throw new ArtifactError("File exceeds the publication size limit", 413);
  }
  return { path, mediaType, bytes };
}

export function validatePublication(
  value: unknown,
  directoryLimits: { files: number; totalBytes: number } = PUBLICATION_LIMITS,
): ValidatedPublication {
  const body = requireObject(value, "Publication");
  if (body.listen !== undefined && typeof body.listen !== "boolean")
    throw new ArtifactError("listen must be a boolean");
  const content = requireObject(body.content, "Publication content");
  const metadata = {
    listen: body.listen !== false,
    expectedSeq: requireSequence(body.expectedSeq, true),
    publicationKey: requireString(body.publicationKey, "publicationKey", 200),
    actor: requireActor(body.actor),
    label: optionalText(body.label, "label", 1000),
    summary: optionalText(body.summary, "summary"),
    provenance: jsonObject(body.provenance === undefined ? {} : body.provenance, "provenance"),
  };
  if (content.kind === "diff") {
    const patch = requireString(content.patch, "Patch", PUBLICATION_LIMITS.patchBytes);
    if (Buffer.byteLength(patch) > PUBLICATION_LIMITS.patchBytes) {
      throw new ArtifactError("Patch exceeds the publication size limit", 413);
    }
    validateStoredPatch(patch);
    return {
      ...metadata,
      kind: "diff",
      patch,
      entrypoint: null,
      files: [],
      contentHash: hashBytes(canonicalJson({ kind: "diff", patch })),
    };
  }
  if (content.kind !== "files" && content.kind !== "html") {
    throw new ArtifactError("Publication kind must be files, html, or diff");
  }
  if (!Array.isArray(content.files) || !content.files.length) {
    throw new ArtifactError("A directory publication must contain at least one file");
  }
  if (content.files.length > directoryLimits.files) {
    throw new ArtifactError("Publication contains too many files", 413);
  }
  let total = 0;
  const files = content.files.map((input) => {
    const file = decodeFile(input);
    total += file.bytes.byteLength;
    if (total > directoryLimits.totalBytes) {
      throw new ArtifactError("Publication exceeds the total size limit", 413);
    }
    return file;
  });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path)) throw new ArtifactError("Duplicate file path in publication");
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (paths.has(parts.slice(0, i).join("/"))) {
        throw new ArtifactError("A publication path cannot be both a file and a directory");
      }
    }
    paths.add(file.path);
  }
  let entrypoint: "index.html" | null = null;
  if (content.kind === "files") {
    if (content.entrypoint !== undefined)
      throw new ArtifactError("Files artifacts have no entrypoint");
  } else {
    if (!paths.has("index.html"))
      throw new ArtifactError(
        "HTML requires a root index.html; publish Markdown as a files artifact",
      );
    if (content.entrypoint !== undefined)
      throw new ArtifactError("HTML entrypoint is selected automatically; omit entrypoint");
    entrypoint = "index.html";
    const index = files.find((file) => file.path === entrypoint)!;
    if (index.mediaType.split(";")[0] !== "text/html") {
      throw new ArtifactError("index.html must have the text/html media type");
    }
  }
  return {
    ...metadata,
    kind: content.kind,
    entrypoint,
    patch: null,
    files,
    contentHash: hashBytes(
      canonicalJson({
        kind: content.kind,
        entrypoint,
        files: files.map((file) => ({
          path: file.path,
          mediaType: file.mediaType,
          hash: hashBytes(file.bytes),
        })),
      }),
    ),
  };
}

// Async work completes before entering SQLite's publication transaction. The
// renderer is injected so retained output can be tested across renderer upgrades.
export async function prepareFiles(
  publication: ValidatedPublication,
  blobs: BlobStore,
  renderDocument: DocumentRenderer,
  retained?: (hash: string, path: string, revision: string) => StoredBlob | null,
): Promise<PreparedFile[]> {
  const prepared: PreparedFile[] = [];
  for (const file of publication.files) {
    const stored = await blobs.put(file.bytes);
    let rendered: PreparedFile["rendered"] = null;
    if (/\.(md|markdown)$/i.test(file.path)) {
      if (file.bytes.byteLength > PUBLICATION_LIMITS.markdownBytes) {
        throw new ArtifactError("Markdown exceeds the rendering size limit", 413);
      }
      let source: string;
      try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
      } catch {
        throw new ArtifactError("Markdown must contain valid UTF-8");
      }
      const declared = renderDocument.revision;
      const cached = declared ? retained?.(stored.hash, file.path, declared) : null;
      if (cached && declared) {
        // Publication holds the blob collector. Verify retained bytes before
        // making another immutable version depend on them.
        await blobs.read(cached.hash);
        rendered = { ...cached, revision: declared };
      } else {
        const document = await renderDocument(source, file.path);
        const revision = requireString(document.revision, "Renderer revision", 200);
        if (declared !== undefined && declared !== revision)
          throw new Error("Document renderer returned a different revision");
        rendered = { ...(await blobs.put(document.html)), revision };
      }
    }
    prepared.push({ path: file.path, mediaType: file.mediaType, ...stored, rendered });
  }
  return prepared;
}
