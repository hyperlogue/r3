import { useQuery } from "@tanstack/react-query";
import { memo, type ReactNode, useEffect, useState } from "react";
import {
  type ArtifactMediaTarget,
  artifactMediaKind,
  type ArtifactFile as PublishedFile,
} from "../../../shared/artifacts.ts";
import { targetableMedia } from "../../../shared/media-target.ts";
import { useArtifactClient } from "../artifact-ui-context.tsx";
import type { DraftAttachment } from "../attachment-drafts.ts";
import type { Region } from "../highlights.ts";
import { useTranslation } from "../i18n.ts";

import type { DiffSide } from "../types.ts";
import { cn, StrokeIcon } from "../ui.tsx";
import { ArtifactMedia } from "./ArtifactMedia.tsx";
import { FileCard, type FoldSignal } from "./FileCard.tsx";
import { MediaViewport } from "./MediaViewport.tsx";
import { RepresentationToggle } from "./RepresentationToggle.tsx";
import { SourceCode } from "./SourceCode.tsx";

// A complete publication is a stack of these cards. Each source query belongs
// to its own body; selecting a file scrolls the stack instead of replacing it.
export const ArtifactFile = memo(function ArtifactFile({
  artifactId,
  versionSeq,
  file,
  theme,
  representation,
  onRepresentation,
  active,
  current,
  viewed,
  onViewed,
  onFileThread,
  onMediaTarget,
  mediaJump,
  mediaActive,
  fold,
  onOpenChange,
  onHydrated,
  regions,
  onPickLines,
  preview,
}: {
  artifactId: string;
  versionSeq: number;
  file: PublishedFile;
  theme: string;
  representation: "source" | "rendered";
  onRepresentation: (representation: "source" | "rendered") => void;
  active: boolean;
  current: boolean;
  viewed: boolean;
  onViewed: () => void;
  onFileThread: () => void;
  onMediaTarget: (target: ArtifactMediaTarget, snapshot: DraftAttachment) => boolean;
  mediaJump?: { target: ArtifactMediaTarget; nonce: number } | null;
  mediaActive?: boolean;
  fold: FoldSignal | null;
  onOpenChange: (open: boolean) => void;
  onHydrated: (ready: boolean) => void;
  regions: Region[];
  onPickLines: (side: DiffSide, start: number, end: number, quote: string) => void;
  preview: () => ReactNode;
}) {
  const { t } = useTranslation();
  const artifactApi = useArtifactClient();
  const [mediaControls, setMediaControls] = useState<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(!viewed);
  const media = artifactMediaKind(file.mediaType);
  const nativeMedia = targetableMedia(file.mediaType);
  const [mediaReady, setMediaReady] = useState(false);
  const filename = file.path.split("/").at(-1)!;
  const canRender = !!file.renderedHash || file.mediaType.split(";")[0] === "text/html";
  const rendered = !!media || (representation === "rendered" && canRender);
  const source = useQuery({
    queryKey: ["artifact-source", artifactId, versionSeq, file.path, theme],
    queryFn: () => artifactApi.source(artifactId, versionSeq, file.path, theme),
    enabled: active && open && !rendered,
    staleTime: Infinity,
    gcTime: 60_000,
  });
  useEffect(() => onOpenChange(open), [open, onOpenChange]);
  useEffect(() => {
    onHydrated(
      active &&
        (!open || (nativeMedia ? mediaReady : rendered || source.isSuccess || source.isError)),
    );
  }, [
    active,
    open,
    nativeMedia,
    mediaReady,
    rendered,
    source.isSuccess,
    source.isError,
    onHydrated,
  ]);
  const downloadUrl = artifactApi.downloadUrl(artifactId, versionSeq, file.path);
  return (
    <FileCard
      path={file.path}
      pathAction={
        <a
          href={downloadUrl}
          download={filename}
          aria-label={t("file.download", { filename })}
          title={t("file.download", { filename })}
          className="flex shrink-0 items-center rounded px-1 py-0.5 text-neutral-500 opacity-0 transition-colors hover:bg-neutral-200 hover:text-neutral-700 group-hover/file-path:opacity-100 group-focus-within/file-path:opacity-100 focus-visible:outline-2 focus-visible:outline-primary-500 pointer-coarse:min-w-7 pointer-coarse:justify-center pointer-coarse:py-2 pointer-coarse:opacity-100 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
        >
          <StrokeIcon className="size-3.5">
            <path d="M12 3v12m-5-5 5 5 5-5" />
            <path d="M5 16v4a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-4" />
          </StrokeIcon>
        </a>
      }
      ownsFileMarker={false}
      current={current}
      viewed={viewed}
      onToggleViewed={onViewed}
      onFileThread={onFileThread}
      foldSignal={fold}
      onOpenChange={setOpen}
      wrapHeader={media === "image" || media === "video"}
      stats={(expanded) =>
        expanded &&
        (media === "image" || media === "video" ? (
          <span
            ref={setMediaControls}
            className="flex min-h-8 flex-wrap items-center justify-end gap-1"
          />
        ) : (
          canRender && <RepresentationToggle value={representation} onChange={onRepresentation} />
        ))
      }
    >
      {active &&
        // Collapse mounts on first open and keeps its children inert while
        // folded. Preserve loaded Markdown so unfolding reuses its document.
        (open || (rendered && !!file.renderedHash)) &&
        (rendered ? (
          <div
            className={cn(
              "flex flex-col",
              !file.renderedHash && !targetableMedia(file.mediaType) && "min-h-96",
            )}
          >
            {targetableMedia(file.mediaType) ? (
              <ArtifactMedia
                artifactId={artifactId}
                versionSeq={versionSeq}
                file={file}
                controls={mediaControls}
                onTarget={onMediaTarget}
                jump={mediaJump}
                active={mediaActive && open}
                onReady={setMediaReady}
              />
            ) : media === "image" ? (
              <MediaViewport controls={mediaControls}>{preview()}</MediaViewport>
            ) : (
              preview()
            )}
          </div>
        ) : source.isPending ? (
          <p className="p-3 text-xs text-neutral-500">{t("file.loadingPublishedSource")}</p>
        ) : source.error ? (
          <p role="alert" className="p-3 text-xs text-red-600">
            {source.error.message}
          </p>
        ) : source.data?.kind === "text" ? (
          <SourceCode
            data={source.data}
            path={file.path}
            regions={regions}
            onPickLines={onPickLines}
          />
        ) : (
          <div className="space-y-2 p-3">
            <p className="text-xs text-neutral-500">
              {t("common.downloadThePublishedFileToOpenIt", {
                source_data_kind_oversize_t_This_file_is:
                  source.data?.kind === "oversize"
                    ? t("file.thisFileIsTooLargeForSource")
                    : t("file.thisFileContainsBinaryContent"),
              })}
            </p>
            <a
              href={downloadUrl}
              download={filename}
              className="inline-flex items-center rounded-md bg-neutral-100 px-2.5 py-1 text-xs font-medium hover:bg-neutral-200 max-md:min-h-9 dark:bg-neutral-800 dark:hover:bg-neutral-700"
            >
              {t("file.downloadFile")}
            </a>
          </div>
        ))}
    </FileCard>
  );
});
