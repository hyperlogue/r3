import { useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";
import type {
  ArtifactDetail,
  ArtifactFile,
  ArtifactMessageContext,
} from "../../shared/artifacts.ts";
import { artifactApi } from "./artifact-api.ts";
import { useArtifactViewed } from "./artifact-hooks.ts";
import {
  artifactRegions,
  defaultFileRepresentation,
  visibleArtifactTargets,
} from "./artifact-navigation.ts";
import { type ArtifactViewSelection, selectedArtifactVersion } from "./artifact-version.ts";
import type { FetchContext } from "./components/DiffView.tsx";
import { compareFilePaths } from "./file-order.ts";
import { useSyntaxTheme } from "./settings.ts";
import type { PatchDiff } from "./types.ts";
import { diffViewedKey, fileViewedKey } from "./viewed.ts";

const filesInTreeOrder = (files: ArtifactFile[]) =>
  files.toSorted((left, right) => compareFilePaths(left.path, right.path));

// All content reads are keyed by the publication and representation. Metadata
// invalidation never replaces immutable source, patch, or retained document bytes.
export function useArtifactContent(
  detail: ArtifactDetail,
  view: ArtifactViewSelection,
  onReadError: (message: string) => void,
) {
  const version = selectedArtifactVersion(detail.versions, view.versionSeq);
  const latest = detail.versions.at(-1);
  const theme = useSyntaxTheme();
  const viewed = useArtifactViewed(detail.id);
  const filesQuery = useQuery({
    queryKey: ["artifact-files", detail.id, version?.seq],
    queryFn: () => artifactApi.files(detail.id, version!.seq),
    enabled: !!version && detail.kind !== "diff",
    select: detail.kind === "files" ? filesInTreeOrder : undefined,
    staleTime: Infinity,
  });
  const diffQuery = useQuery({
    queryKey: ["artifact-diff", detail.id, version?.seq, theme],
    queryFn: () => artifactApi.diff(detail.id, version!.seq, theme),
    enabled: !!version && detail.kind === "diff",
    staleTime: Infinity,
  });
  const files = filesQuery.data;
  const paths = useMemo(
    () =>
      detail.kind === "diff"
        ? (diffQuery.data ?? []).map((file) => file.path)
        : (files ?? []).map((file) => file.path),
    [detail.kind, diffQuery.data, files],
  );
  const path = view.path ?? (version?.kind === "html" ? version.entrypoint : paths[0]) ?? null;
  const file = files?.find((file) => file.path === path);
  const canRender = !!file && (!!file.renderedHash || file.mediaType.split(";")[0] === "text/html");
  const representation =
    detail.kind === "files" && !view.path
      ? defaultFileRepresentation(path ?? "")
      : view.representation;
  const context = useMemo<ArtifactMessageContext>(
    () =>
      version
        ? { versionSeq: version.seq, representation }
        : { versionSeq: null, representation: null },
    [version, representation],
  );
  const regions = useMemo(
    () =>
      version
        ? artifactRegions(
            detail,
            version.seq,
            detail.kind === "files" ? "source" : view.representation,
          ).map((region) => ({
            ...region,
            file: diffQuery.data?.find((file) => file.oldPath === region.file)?.path ?? region.file,
          }))
        : [],
    [detail, version, view.representation, diffQuery.data],
  );
  const renderedTargets = useMemo(
    () => (version ? visibleArtifactTargets(detail, version.seq, "rendered") : []),
    [detail, version],
  );
  const viewedPaths = useMemo(
    () =>
      new Set(
        paths.filter((path) => {
          const file = files?.find((file) => file.path === path);
          return detail.kind === "diff"
            ? !!version && viewed.isViewed(diffViewedKey(version.seq, path))
            : !!file && viewed.isViewed(fileViewedKey(path, file.hash));
        }),
      ),
    [paths, files, detail.kind, version, viewed.isViewed],
  );
  const rounds = useMemo<PatchDiff[]>(
    () =>
      version && diffQuery.data
        ? [
            {
              seq: version.seq,
              files: diffQuery.data,
            },
          ]
        : [],
    [version, diffQuery.data],
  );
  const fetchContext = useCallback<FetchContext>(
    async (path, start, end) => {
      if (!version) return null;
      try {
        return (await artifactApi.context(detail.id, version.seq, path, start, end, theme)).lines;
      } catch (error) {
        onReadError(error instanceof Error ? error.message : "Could not read captured context.");
        return null;
      }
    },
    [detail.id, version, theme, onReadError],
  );

  return {
    version,
    latest,
    theme,
    viewed,
    filesQuery,
    diffQuery,
    paths,
    path,
    file,
    canRender,
    context,
    regions,
    renderedTargets,
    viewedPaths,
    rounds,
    fetchContext,
  };
}
