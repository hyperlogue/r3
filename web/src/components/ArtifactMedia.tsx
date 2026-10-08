import { type PointerEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ArtifactFile, ArtifactMediaTarget, MediaBox } from "../../../shared/artifacts.ts";
import {
  animatedImage,
  FULL_MEDIA_BOX,
  mediaTime,
  targetableMedia,
} from "../../../shared/media-target.ts";
import { artifactApi } from "../artifact-api.ts";
import { useArtifactMediaDraftFrame } from "../artifact-drafts.ts";
import { type DraftAttachment, saveDraftImageOutput } from "../attachment-drafts.ts";
import { cn, StrokeIcon } from "../ui.tsx";
import { MediaBoxOverlay, useMediaImage } from "./MediaTargetPreview.tsx";
import { MediaViewport } from "./MediaViewport.tsx";

const iconClass =
  "flex size-6 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700 focus-visible:outline-2 focus-visible:outline-primary-500 disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200";

// Only decoded raster images and videos enter this component. Authenticated
// bytes become local blob URLs; no document scripts or resource URLs execute.
export function ArtifactMedia({
  artifactId,
  versionSeq,
  file,
  controls,
  onTarget,
  jump,
  active = true,
  showTarget = true,
  onSavedFrame,
}: {
  artifactId: string;
  versionSeq: number;
  file: ArtifactFile;
  controls?: HTMLElement | null;
  onTarget?: (target: ArtifactMediaTarget, snapshot: DraftAttachment) => boolean;
  jump?: { target: ArtifactMediaTarget; nonce: number } | null;
  active?: boolean;
  showTarget?: boolean;
  onSavedFrame?: (saved: boolean) => void;
}) {
  const kind = targetableMedia(file.mediaType);
  const feedbackLabel = kind === "video" ? "Add video feedback" : "Add image feedback";
  const currentDraftFrame = useArtifactMediaDraftFrame(artifactId);
  const [acceptedFrame, setAcceptedFrame] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [animated, setAnimated] = useState(false);
  const [ready, setReady] = useState(false);
  const [duration, setDuration] = useState(0);
  const [paused, setPaused] = useState(true);
  const [time, setTime] = useState(0);
  const video = useRef<HTMLVideoElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const savedImage = useRef<HTMLImageElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const player = useRef<HTMLDivElement>(null);
  const feedbackAction = useRef<HTMLButtonElement>(null);
  const selection = useRef<HTMLButtonElement>(null);
  const [selecting, setSelecting] = useState(false);
  const [box, setBox] = useState<MediaBox>(FULL_MEDIA_BOX);
  const [frozen, setFrozen] = useState<{
    canvas: HTMLCanvasElement;
    url: string;
    time: number | null;
  } | null>(null);
  const frozenRef = useRef(frozen);
  frozenRef.current = frozen;
  const [muted, setMuted] = useState(true);
  const [saving, setSaving] = useState(false);
  const alive = useRef(true);
  const drag = useRef<{ x: number; y: number; id: number } | null>(null);
  const saved = useMediaImage(jump?.target.locator.frame);
  const [showSaved, setShowSaved] = useState(false);
  useEffect(() => {
    alive.current = true;
    let cancelled = false;
    let held = "";
    setReady(false);
    setUrl("");
    setError("");
    void artifactApi
      .download(artifactId, versionSeq, file.path)
      .then((response) => response.blob())
      .then(async (blob) => {
        const animation =
          kind === "image" &&
          animatedImage(new Uint8Array(await blob.arrayBuffer()), file.mediaType);
        if (cancelled) return;
        setAnimated(animation);
        held = URL.createObjectURL(blob);
        setUrl(held);
      })
      .catch((error) => {
        if (!cancelled) setError(error.message);
      });
    const clear = () => {
      cancelled = true;
      alive.current = false;
      video.current?.pause();
      URL.revokeObjectURL(held);
      setUrl("");
    };
    window.addEventListener("r3-images-cleared", clear);
    return () => {
      window.removeEventListener("r3-images-cleared", clear);
      clear();
    };
  }, [artifactId, versionSeq, file.path, file.mediaType, kind]);
  useEffect(() => {
    onSavedFrame?.(showSaved && !!saved.url);
  }, [showSaved, saved.url, onSavedFrame]);
  useEffect(() => {
    if (!active) video.current?.pause();
  }, [active]);
  useEffect(() => {
    if (selecting) selection.current?.focus({ preventScroll: true });
  }, [selecting]);
  useEffect(() => {
    if (!jump || !ready) return;
    video.current?.pause();
    if (video.current && jump.target.locator.time !== null)
      video.current.currentTime = jump.target.locator.time;
    setBox(jump.target.locator.box);
    setFrozen(null);
    setSelecting(false);
    setShowSaved(true);
  }, [jump, ready]);

  const freeze = () => {
    if (frozenRef.current) return frozenRef.current;
    const viewingSaved = showSaved && !!saved.url;
    const element = viewingSaved
      ? savedImage.current
      : kind === "video"
        ? video.current
        : image.current;
    if (!element || !ready || animated || (element instanceof HTMLVideoElement && element.seeking))
      throw new Error("Wait for the media frame to finish loading.");
    video.current?.pause();
    const width = element instanceof HTMLVideoElement ? element.videoWidth : element.naturalWidth;
    const height =
      element instanceof HTMLVideoElement ? element.videoHeight : element.naturalHeight;
    if (!width || !height || width * height > 20_000_000)
      throw new Error("Frame capture supports images up to 20 megapixels.");
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")!.drawImage(element, 0, 0, width, height);
    const value = {
      canvas,
      url: canvas.toDataURL("image/png"),
      time: viewingSaved
        ? (jump?.target.locator.time ?? null)
        : element instanceof HTMLVideoElement
          ? element.currentTime
          : null,
    };
    frozenRef.current = value;
    setFrozen(value);
    setShowSaved(false);
    return value;
  };
  const select = () => {
    try {
      freeze();
      setBox(FULL_MEDIA_BOX);
      setSelecting(!selecting);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const add = async (selectedBox: MediaBox) => {
    if (!onTarget || saving) return;
    try {
      const captured = freeze();
      setSaving(true);
      setSelecting(false);
      setBox(selectedBox);
      const blob = await new Promise<Blob>((resolve, reject) =>
        captured.canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(new Error("Unable to capture this frame"))),
          "image/png",
        ),
      );
      const output = await saveDraftImageOutput(artifactId, {
        blob,
        width: captured.canvas.width,
        height: captured.canvas.height,
      });
      if (!alive.current) return;
      const accepted = onTarget(
        {
          kind: "media",
          versionSeq,
          path: file.path,
          locator: { time: captured.time, box: selectedBox },
        },
        output.attachment,
      );
      setAcceptedFrame(accepted ? output.attachment.id : null);
      if (!output.persisted)
        setError("Frame saved for this tab only. Keep the tab open until you post your feedback.");
    } catch (e) {
      if (alive.current) setError((e as Error).message);
    } finally {
      if (alive.current) setSaving(false);
    }
  };
  const point = (event: PointerEvent) => {
    const rect = surface.current!.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  };
  const overlay = showSaved && saved.url ? saved.url : frozen?.url;
  const targetBox = showSaved && jump ? jump.target.locator.box : box;
  const actions = (
    <>
      {kind === "video" && (
        <span className="text-[0.625rem] tabular-nums text-neutral-500">
          {mediaTime(showSaved && jump ? (jump.target.locator.time ?? 0) : (frozen?.time ?? time))}
        </span>
      )}
      {onTarget && !animated && (
        <button
          ref={feedbackAction}
          type="button"
          className={cn(
            iconClass,
            selecting && "bg-primary-500/15 text-primary-600 dark:text-primary-400",
          )}
          title={feedbackLabel}
          aria-label={feedbackLabel}
          aria-pressed={selecting}
          disabled={!ready || saving}
          onClick={select}
        >
          <StrokeIcon className="size-3.5">
            <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 12h8m-4-4v8" />
          </StrokeIcon>
        </button>
      )}
      {jump?.target.locator.frame && (
        <button
          type="button"
          className={iconClass}
          aria-label="View saved frame"
          title="View saved frame"
          onClick={() => {
            video.current?.pause();
            setShowSaved(true);
          }}
        >
          <StrokeIcon className="size-3.5">
            <rect x="3" y="3" width="18" height="18" rx="1" />
            <path d="m3 17 6-6 4 4 3-3 5 5" />
          </StrokeIcon>
        </button>
      )}
    </>
  );
  return (
    <div ref={player} className="flex flex-col" data-native-media>
      {controls && createPortal(actions, controls)}
      {error && (
        <p role="alert" className="px-3 py-2 text-xs text-red-600">
          {error}
        </p>
      )}
      {saved.error && (
        <p role="alert" className="px-3 py-2 text-xs text-red-600">
          {saved.error}
        </p>
      )}
      {!url ? (
        <p className="p-3 text-xs text-neutral-500">Loading media…</p>
      ) : (
        <>
          <MediaViewport
            controls={controls}
            disabled={!ready}
            selecting={selecting}
            selectionHint={selecting ? "Click for full frame · Drag for region" : undefined}
            resetKey={jump?.nonce}
          >
            <div ref={surface} className="relative w-full" data-media-frame>
              {kind === "video" ? (
                <video
                  ref={video}
                  muted={muted}
                  src={url}
                  playsInline
                  preload="auto"
                  className="block w-full"
                  onLoadedData={() => {
                    setReady(true);
                    setDuration(video.current?.duration ?? 0);
                  }}
                  onTimeUpdate={() => setTime(video.current?.currentTime ?? 0)}
                  onError={() => setError("This browser could not decode the video.")}
                  onPlay={() => {
                    setPaused(false);
                    setShowSaved(false);
                    setFrozen(null);
                    setSelecting(false);
                  }}
                  onPause={() => setPaused(true)}
                  onVolumeChange={() => setMuted(video.current?.muted ?? true)}
                >
                  <track kind="captions" />
                </video>
              ) : (
                <img
                  ref={image}
                  src={url}
                  alt={file.path}
                  className="block w-full"
                  onLoad={() => setReady(true)}
                  onError={() => setError("This browser could not decode the image.")}
                />
              )}
              {overlay && (
                <img
                  ref={savedImage}
                  src={overlay}
                  alt="Saved frame"
                  className="pointer-events-none absolute inset-0 h-full w-full"
                />
              )}
              {showTarget &&
                (showSaved ||
                  selecting ||
                  saving ||
                  (frozen && acceptedFrame && acceptedFrame === currentDraftFrame)) && (
                  <MediaBoxOverlay box={targetBox} />
                )}
              {selecting && (
                <button
                  ref={selection}
                  type="button"
                  data-media-selection
                  aria-label="Click or press Enter for full-frame feedback, drag to select a region, or press Escape to cancel"
                  className="absolute inset-0 touch-none cursor-crosshair focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-primary-500"
                  onClick={(event) => {
                    if (event.detail === 0) void add(FULL_MEDIA_BOX);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      setSelecting(false);
                      feedbackAction.current?.focus({ preventScroll: true });
                    } else if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      event.stopPropagation();
                      if (!event.repeat) void add(FULL_MEDIA_BOX);
                    }
                  }}
                  onPointerDown={(event) => {
                    if (event.button !== 0 || drag.current) return;
                    event.currentTarget.setPointerCapture(event.pointerId);
                    drag.current = { ...point(event), id: event.pointerId };
                  }}
                  onPointerMove={(event) => {
                    const from = drag.current;
                    if (!from || from.id !== event.pointerId) return;
                    const to = point(event);
                    setBox({
                      x: Math.min(from.x, to.x),
                      y: Math.min(from.y, to.y),
                      width: Math.abs(from.x - to.x),
                      height: Math.abs(from.y - to.y),
                    });
                  }}
                  onPointerUp={(event) => {
                    const from = drag.current;
                    if (!from || from.id !== event.pointerId) return;
                    const to = point(event);
                    const region = {
                      x: Math.min(from.x, to.x),
                      y: Math.min(from.y, to.y),
                      width: Math.abs(from.x - to.x),
                      height: Math.abs(from.y - to.y),
                    };
                    const rect = surface.current!.getBoundingClientRect();
                    drag.current = null;
                    void add(
                      region.width * rect.width < 4 || region.height * rect.height < 4
                        ? FULL_MEDIA_BOX
                        : region,
                    );
                  }}
                  onPointerCancel={() => {
                    setBox(FULL_MEDIA_BOX);
                    drag.current = null;
                  }}
                />
              )}
            </div>
          </MediaViewport>
          {kind === "video" && (
            <div className="flex items-center gap-2 px-3 py-2">
              <button
                type="button"
                className={iconClass}
                aria-label={paused ? "Play video" : "Pause video"}
                disabled={!ready}
                onClick={() => {
                  const element = video.current;
                  if (!element) return;
                  if (element.paused) {
                    void element.play().catch((e) => setError(e.message));
                  } else element.pause();
                }}
              >
                <StrokeIcon className="size-4">
                  {paused ? <path d="m7 4 14 8-14 8Z" /> : <path d="M8 4v16M16 4v16" />}
                </StrokeIcon>
              </button>
              <span className="text-[0.625rem] tabular-nums text-neutral-500">
                {mediaTime(time)}
              </span>
              <input
                type="range"
                min="0"
                max={Number.isFinite(duration) ? duration : 0}
                step="0.001"
                value={time}
                aria-label="Video position"
                disabled={!ready}
                className="min-w-0 flex-1 accent-primary-500"
                onChange={(event) => {
                  setShowSaved(false);
                  setFrozen(null);
                  setSelecting(false);
                  if (video.current) video.current.currentTime = Number(event.target.value);
                  setTime(Number(event.target.value));
                }}
              />
              <span className="text-[0.625rem] tabular-nums text-neutral-500">
                {mediaTime(Number.isFinite(duration) ? duration : 0)}
              </span>
              <button
                type="button"
                className={iconClass}
                aria-label={muted ? "Unmute video" : "Mute video"}
                onClick={() => {
                  if (video.current) video.current.muted = !muted;
                  setMuted(!muted);
                }}
              >
                <StrokeIcon className="size-3.5">
                  <path d="m11 5-6 4H2v6h3l6 4V5Z" />
                  {muted ? (
                    <path d="m16 9 5 6m0-6-5 6" />
                  ) : (
                    <path d="M15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" />
                  )}
                </StrokeIcon>
              </button>
              <button
                type="button"
                className={iconClass}
                aria-label="Full screen video"
                onClick={() => {
                  void player.current?.requestFullscreen?.().catch((e) => setError(e.message));
                }}
              >
                <StrokeIcon className="size-3.5">
                  <path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5" />
                </StrokeIcon>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
