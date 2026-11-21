import type { ArtifactFile } from "../../../shared/artifacts.ts";
import { publishedBytes } from "./published-bytes.ts";

// A Blob plays only once it is complete. Waiting is acceptable for a short
// clip; anything longer streams from the preview origin on its first visit.
const WHOLE_MEDIA_BYTES = 8 * 1024 * 1024;

// Answers a preview's asset call from retained bytes. Undefined means the
// method belongs to another part of the preview bridge; a null result tells
// the preview to stream the media file itself. A preview relays only after
// `relaysAssets` confirms that this workspace does.
export function relayedAssetCall(
  method: string,
  input: unknown,
  artifactId: string,
  files: ArtifactFile[],
  signal: AbortSignal,
): Promise<Blob | boolean | null> | undefined {
  if (method === "relaysAssets") return Promise.resolve(true);
  if (method !== "readAsset" && method !== "readMedia") return undefined;
  const media = method === "readMedia";
  const request = media ? ((input ?? {}) as { path?: unknown; eager?: unknown }) : { path: input };
  const file = files.find((member) => member.path === request.path);
  if (!file) return Promise.reject(new Error("Asset is not a published file in this version"));
  if (!media) return publishedBytes.load(artifactId, file, signal);
  return publishedBytes
    .cached(artifactId, file)
    .then(
      (retained) =>
        retained ??
        (request.eager === true && file.byteLength <= WHOLE_MEDIA_BYTES
          ? publishedBytes.load(artifactId, file, signal)
          : null),
    );
}

export const reconcileRelayedAssets = (listArtifacts: () => Promise<string[]>) =>
  publishedBytes.reconcile(listArtifacts);
