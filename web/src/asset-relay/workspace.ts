import type { ArtifactFile } from "../../../shared/artifacts.ts";
import { publishedBytes } from "./published-bytes.ts";

// Answers a preview's asset call from retained bytes. Undefined means the
// method belongs to another part of the preview bridge.
export function relayedAssetCall(
  method: string,
  input: unknown,
  artifactId: string,
  files: ArtifactFile[],
  signal: AbortSignal,
): Promise<Blob> | undefined {
  if (method !== "readAsset") return undefined;
  const file = files.find((member) => member.path === input);
  if (!file) return Promise.reject(new Error("Asset is not a published file in this version"));
  return publishedBytes.load(artifactId, file, signal);
}

export const reconcileRelayedAssets = (listArtifacts: () => Promise<string[]>) =>
  publishedBytes.reconcile(listArtifacts);
