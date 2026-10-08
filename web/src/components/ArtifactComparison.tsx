import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactDetail, ArtifactMediaTarget } from "../../../shared/artifacts.ts";
import { artifactApi } from "../artifact-api.ts";
import type { ArtifactComparison as Comparison, ComparisonTarget } from "../artifact-comparison.ts";
import type { ArtifactRenderer } from "../pages/ArtifactView.tsx";
import { Button, cn, StrokeIcon } from "../ui.tsx";
import { ArtifactMedia } from "./ArtifactMedia.tsx";

export type ComparisonSide = "original" | "proposed";

export function ArtifactComparison({
  detail,
  comparison,
  renderPreview,
  active,
  side,
  onBack,
  onStep,
  position,
  count,
}: {
  detail: ArtifactDetail;
  comparison: Comparison | null;
  renderPreview: ArtifactRenderer;
  active: boolean;
  // A mobile container selects one side; desktop retains both mounted panes.
  side?: ComparisonSide;
  onBack: () => void;
  onStep: (direction: -1 | 1) => void;
  position: number;
  count: number;
}) {
  const [stacked, setStacked] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [targets, setTargets] = useState(true);
  const [focus, setFocus] = useState(0);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (active) back.current?.focus({ preventScroll: true });
  }, [active]);
  return (
    <section
      aria-label="Compare proposed fix"
      data-artifact-comparison
      className="flex h-full min-h-0 min-w-0 flex-col bg-neutral-50 dark:bg-neutral-950"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-neutral-300 px-2 py-1 dark:border-neutral-700">
        <Button ref={back} variant="ghost" onClick={onBack} aria-label="Return to artifact">
          <StrokeIcon className="size-3.5">
            <path d="m12 5-7 7 7 7M5 12h15" />
          </StrokeIcon>
          Artifact
        </Button>
        <div className="flex-1" />
        <Button
          variant={targets ? "primary-outline" : "ghost"}
          aria-pressed={targets}
          onClick={() => setTargets(!targets)}
        >
          Targets
        </Button>
        <Button
          variant="ghost"
          aria-label={comparison?.original.kind === "media" ? "Return to targets" : "Focus targets"}
          onClick={() => setFocus((value) => value + 1)}
        >
          {comparison?.original.kind === "media" ? "Return to targets" : "Focus"}
        </Button>
        <Button
          className="max-md:hidden"
          variant={narrow ? "primary-outline" : "ghost"}
          aria-pressed={narrow}
          onClick={() => setNarrow(!narrow)}
        >
          Narrow
        </Button>
        <Button
          className="max-md:hidden"
          variant="ghost"
          aria-label={stacked ? "Show side by side" : "Stack comparison"}
          onClick={() => setStacked(!stacked)}
        >
          {stacked ? "Side by side" : "Stack"}
        </Button>
        <Button
          variant="ghost"
          aria-label="Previous comparison"
          disabled={position <= 0}
          onClick={() => onStep(-1)}
        >
          ←
        </Button>
        <span className="text-xs tabular-nums text-neutral-500">
          {position < 0 ? 0 : position + 1} / {count}
        </span>
        <Button
          variant="ghost"
          aria-label="Next comparison"
          disabled={position < 0 || position >= count - 1}
          onClick={() => onStep(1)}
        >
          →
        </Button>
      </div>
      {comparison ? (
        <div
          className={cn(
            "flex min-h-0 min-w-0 flex-1 overflow-hidden",
            stacked && !side && "flex-col",
          )}
        >
          {(["original", "proposed"] as const).map((name) => (
            <div
              key={name}
              data-comparison-side={name}
              inert={!active || (!!side && side !== name)}
              aria-hidden={!!side && side !== name}
              className={cn(
                "flex min-h-0 min-w-0 flex-1 flex-col",
                side && side !== name && "hidden",
                name === "proposed" && !side && (stacked ? "border-t" : "border-l"),
                "border-neutral-300 dark:border-neutral-700",
              )}
            >
              <ComparisonPreview
                key={`${comparison.replyId}:${name}`}
                detail={detail}
                target={comparison[name]}
                label={name === "original" ? "Original" : "Proposed fix"}
                renderPreview={renderPreview}
                active={active && (!side || side === name)}
                layout={side ? "single" : stacked ? "stacked" : "split"}
                targets={targets}
                narrow={narrow && !side}
                focus={focus}
              />
            </div>
          ))}
        </div>
      ) : (
        <p role="status" className="p-6 text-sm text-neutral-500">
          This comparison is no longer available. Return to the artifact to read its feedback.
        </p>
      )}
    </section>
  );
}

function ComparisonPreview({
  detail,
  target,
  label,
  renderPreview,
  active,
  layout,
  targets,
  narrow,
  focus,
}: {
  detail: ArtifactDetail;
  target: ComparisonTarget;
  label: string;
  renderPreview: ArtifactRenderer;
  active: boolean;
  layout: "single" | "stacked" | "split";
  targets: boolean;
  narrow: boolean;
  focus: number;
}) {
  const [savedFrame, setSavedFrame] = useState(false);
  const [path, setPath] = useState(target.path);
  const [mediaControls, setMediaControls] = useState<HTMLSpanElement | null>(null);
  const [state, setState] = useState<"anchored" | "ambiguous" | "unplaced" | null>(null);
  const version = detail.versions.find((version) => version.seq === target.versionSeq);
  const [nonce, setNonce] = useState(0);
  // The explicit Focus action retries the same target after page interaction.
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit focus and viewport changes retry the same target
  useEffect(() => {
    if (!active) return;
    setPath(target.path);
    setState(null);
    setNonce((value) => value + 1);
  }, [active, target.path, focus, layout, narrow]);
  const jump = useMemo(
    () => (target.kind === "rendered" ? { locator: target.locator, nonce } : null),
    [target, nonce],
  );
  return (
    <>
      <div className="flex shrink-0 items-center gap-2 border-b border-neutral-200 px-3 py-2 text-xs dark:border-neutral-800">
        <strong className="font-medium">{label}</strong>
        <span className="text-neutral-500">v{target.versionSeq}</span>
        <span
          className="min-w-0 flex-1 truncate text-neutral-500"
          title={
            target.kind === "media" ? target.path : `${target.path} · ${target.locator.selector}`
          }
        >
          {target.kind === "media"
            ? target.path
            : (target.locator.label ?? target.locator.selector)}
        </span>
        {target.kind === "media" && (
          <span ref={setMediaControls} className="flex items-center gap-1" />
        )}
        <span
          role="status"
          data-comparison-target-state={state ?? "locating"}
          className={cn(
            "shrink-0 text-[0.625rem]",
            state === "anchored" ? "text-success-700 dark:text-success-400" : "text-neutral-500",
          )}
        >
          {target.kind === "media"
            ? savedFrame
              ? "Saved frame"
              : "Playback"
            : state === "anchored"
              ? "Located"
              : state === "ambiguous"
                ? "Multiple matches"
                : state === "unplaced"
                  ? "Target unavailable"
                  : "Locating…"}
        </span>
      </div>
      <div data-artifact-content className="flex min-h-0 flex-1 overflow-auto">
        <div className={cn("mx-auto flex min-h-0 w-full flex-col", narrow && "max-w-[390px]")}>
          {target.kind === "media" ? (
            <MediaComparison
              artifactId={detail.id}
              target={target}
              controls={mediaControls}
              active={active}
              showTarget={targets}
              nonce={nonce}
              onSavedFrame={setSavedFrame}
            />
          ) : (
            version &&
            renderPreview({
              detail,
              version,
              path,
              commenting: false,
              jump,
              targets: [],
              onTarget: () => {},
              onDocument: setPath,
              onFeedback: () => {},
              active,
              highlightLocated: targets,
              onLocated: setState,
              independentReading: true,
              previewLabel: `${label} · v${target.versionSeq} · ${target.path}`,
            })
          )}
        </div>
      </div>
    </>
  );
}

function MediaComparison({
  artifactId,
  target,
  controls,
  active,
  showTarget,
  nonce,
  onSavedFrame,
}: {
  artifactId: string;
  target: ArtifactMediaTarget;
  controls: HTMLElement | null;
  active: boolean;
  showTarget: boolean;
  nonce: number;
  onSavedFrame: (saved: boolean) => void;
}) {
  const files = useQuery({
    queryKey: ["artifact-files", artifactId, target.versionSeq],
    queryFn: () => artifactApi.files(artifactId, target.versionSeq),
    staleTime: Infinity,
  });
  const file = files.data?.find((file) => file.path === target.path);
  const jump = useMemo(() => ({ target, nonce }), [target, nonce]);
  return file ? (
    <ArtifactMedia
      artifactId={artifactId}
      versionSeq={target.versionSeq}
      file={file}
      controls={controls}
      active={active}
      showTarget={showTarget}
      jump={jump}
      onSavedFrame={onSavedFrame}
    />
  ) : (
    <p role="status" className="p-3 text-xs text-neutral-500">
      {files.error ? files.error.message : files.isPending ? "Loading media…" : "Media unavailable"}
    </p>
  );
}
