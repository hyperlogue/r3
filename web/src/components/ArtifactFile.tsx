import { useMutation, useQuery } from "@tanstack/react-query";
import { memo, type ReactNode, useEffect, useState } from "react";
import {
  artifactMediaKind,
  type ArtifactFile as PublishedFile,
} from "../../../shared/artifacts.ts";
import { artifactApi } from "../artifact-api.ts";
import type { Region } from "../highlights.ts";
import type { DiffSide } from "../types.ts";
import { Button, cn } from "../ui.tsx";
import { FileCard, type FoldSignal } from "./FileCard.tsx";
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
  onFileFeedback,
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
  onFileFeedback: () => void;
  fold: FoldSignal | null;
  onOpenChange: (open: boolean) => void;
  onHydrated: (ready: boolean) => void;
  regions: Region[];
  onPickLines: (side: DiffSide, start: number, end: number, quote: string) => void;
  preview: () => ReactNode;
}) {
  const [open, setOpen] = useState(!viewed);
  const media = artifactMediaKind(file.mediaType);
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
    onHydrated(active && (!open || rendered || source.isSuccess || source.isError));
  }, [active, open, rendered, source.isSuccess, source.isError, onHydrated]);
  const download = useMutation({
    mutationFn: async () => {
      const response = await artifactApi.download(artifactId, versionSeq, file.path);
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = file.path.split("/").at(-1)!;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
    },
  });
  return (
    <FileCard
      path={file.path}
      ownsFileMarker={false}
      current={current}
      viewed={viewed}
      onToggleViewed={onViewed}
      onFileFeedback={onFileFeedback}
      foldSignal={fold}
      onOpenChange={setOpen}
      stats={(expanded) =>
        expanded &&
        canRender && <RepresentationToggle value={representation} onChange={onRepresentation} />
      }
    >
      {active &&
        // Collapse mounts on first open and keeps its children inert while
        // folded. Preserve loaded Markdown so unfolding reuses its document.
        (open || (rendered && !!file.renderedHash)) &&
        (rendered ? (
          <div className={cn("flex flex-col", !file.renderedHash && "min-h-96")}>{preview()}</div>
        ) : source.isPending ? (
          <p className="p-3 text-xs text-neutral-500">Loading published source…</p>
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
              {source.data?.kind === "oversize"
                ? "This file is too large for source highlighting."
                : "This file contains binary content."}{" "}
              Download the published file to open it.
            </p>
            <Button disabled={download.isPending} onClick={() => download.mutate()}>
              {download.isPending ? "Downloading…" : "Download file"}
            </Button>
          </div>
        ))}
      {download.error && (
        <p role="alert" className="p-3 text-xs text-red-600">
          {download.error.message}
        </p>
      )}
    </FileCard>
  );
});
