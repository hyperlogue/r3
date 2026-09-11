import type {
  ArtifactKind,
  ArtifactTarget,
  ArtifactVersion,
  Representation,
} from "../../shared/artifacts.ts";

export interface ArtifactViewSelection {
  // Null follows the latest publication. Explicit historical choices never move
  // just because a publication arrives or a reference cannot be found.
  versionSeq: number | null;
  path: string | null;
  representation: Representation;
}

export function selectedArtifactVersion(
  versions: ArtifactVersion[],
  seq: number | null,
): ArtifactVersion | null {
  return seq === null
    ? (versions.at(-1) ?? null)
    : (versions.find((version) => version.seq === seq) ?? null);
}

export function stepArtifactVersion(
  versions: ArtifactVersion[],
  seq: number | null,
  direction: -1 | 1,
): number | null {
  const current = selectedArtifactVersion(versions, seq);
  if (!current) return seq;
  const at = versions.indexOf(current);
  return versions[Math.max(0, Math.min(versions.length - 1, at + direction))].seq;
}

export function artifactViewForTarget(
  kind: ArtifactKind,
  target: ArtifactTarget,
  current: ArtifactViewSelection,
): ArtifactViewSelection {
  if (target.kind === "artifact" || target.kind === "artifact_summary") return current;
  if (target.kind === "version_summary")
    return {
      versionSeq: target.versionSeq,
      path: null,
      representation: kind === "html" ? "rendered" : kind === "diff" ? "diff" : "source",
    };
  return { versionSeq: target.versionSeq, path: target.path, representation: target.kind };
}
