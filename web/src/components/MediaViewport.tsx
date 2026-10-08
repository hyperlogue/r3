import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn, StrokeIcon } from "../ui.tsx";

const levels = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8];
const buttonClass =
  "flex size-6 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-200 hover:text-neutral-700 focus-visible:outline-2 focus-visible:outline-primary-500 disabled:opacity-40 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200";
type Offset = { x: number; y: number };
const center: Offset = { x: 0, y: 0 };
const constrain = (offset: Offset, zoom: number): Offset => {
  const limit = Math.max(0, (zoom - 1) / 2);
  return {
    x: Math.max(-limit, Math.min(limit, offset.x)),
    y: Math.max(-limit, Math.min(limit, offset.y)),
  };
};

// View transforms never alter intrinsic media coordinates or captured pixels.
// Offsets use unscaled viewport units so resizing preserves a bounded view.
export function MediaViewport({
  children,
  controls,
  selecting = false,
  selectionHint,
  resetKey,
  disabled = false,
}: {
  children: ReactNode;
  controls?: HTMLElement | null;
  selecting?: boolean;
  selectionHint?: string;
  resetKey?: number;
  disabled?: boolean;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const transform = useRef<HTMLDivElement>(null);
  const [animate, setAnimate] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState(center);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ id: number; x: number; y: number; offset: Offset } | null>(null);
  const panning = zoom > 1 && !selecting;
  const reset = () => {
    setAnimate(true);
    setZoom(1);
    setOffset(center);
    setDragging(false);
    drag.current = null;
  };
  // Locate and Return to targets restore a complete, unobscured frame.
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit target navigation resets the view
  useEffect(reset, [resetKey]);
  const changeZoom = (next: number) => {
    setAnimate(true);
    setOffset((value) =>
      constrain({ x: (value.x * next) / zoom, y: (value.y * next) / zoom }, next),
    );
    setZoom(next);
  };
  const actions = (
    <span data-media-zoom-controls className="flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        className={buttonClass}
        title="Zoom out"
        aria-label="Zoom out"
        disabled={disabled || zoom === levels[0]}
        onClick={() => changeZoom(levels[levels.indexOf(zoom) - 1]!)}
      >
        <StrokeIcon className="size-3.5">
          <path d="M5 12h14" />
        </StrokeIcon>
      </button>
      <button
        type="button"
        className={cn(buttonClass, "w-10 text-[0.625rem] tabular-nums")}
        title="Reset zoom to fit"
        aria-label="Reset zoom"
        disabled={disabled}
        onClick={reset}
      >
        {Math.round(zoom * 100)}%
      </button>
      <button
        type="button"
        className={buttonClass}
        title="Zoom in"
        aria-label="Zoom in"
        disabled={disabled || zoom === levels.at(-1)}
        onClick={() => changeZoom(levels[levels.indexOf(zoom) + 1]!)}
      >
        <StrokeIcon className="size-3.5">
          <path d="M5 12h14m-7-7v14" />
        </StrokeIcon>
      </button>
    </span>
  );
  return (
    <>
      {controls && createPortal(actions, controls)}
      <div
        ref={viewport}
        className="relative overflow-hidden"
        data-media-viewport
        data-zoom={zoom}
        onPointerDownCapture={() => {
          // Settle zoom before either a region or pan gesture reads geometry.
          for (const animation of transform.current?.getAnimations() ?? []) animation.finish();
        }}
      >
        <div
          ref={transform}
          data-media-transform
          className={cn(
            "origin-center",
            animate && "transition-transform duration-150 ease-out motion-reduce:transition-none",
          )}
          style={{ transform: `translate(${offset.x * 100}%, ${offset.y * 100}%) scale(${zoom})` }}
        >
          {children}
        </div>
        {selectionHint && (
          <div className="pointer-events-none absolute inset-x-0 top-0 bg-white/85 px-2 py-1 text-center text-xs text-neutral-600 dark:bg-neutral-950/85 dark:text-neutral-300">
            {selectionHint}
          </div>
        )}
        {panning && (
          <div
            role="application"
            aria-label="Pan media with drag or arrow keys"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the two-dimensional pan surface handles keyboard arrows when zoomed in
            tabIndex={0}
            className={cn(
              "absolute inset-0 touch-none outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-primary-500",
              dragging ? "cursor-grabbing" : "cursor-grab",
            )}
            onKeyDown={(event) => {
              const directions: Record<string, Offset> = {
                ArrowLeft: { x: 0.1, y: 0 },
                ArrowRight: { x: -0.1, y: 0 },
                ArrowUp: { x: 0, y: 0.1 },
                ArrowDown: { x: 0, y: -0.1 },
              };
              const step = directions[event.key];
              if (!step) return;
              event.preventDefault();
              event.stopPropagation();
              setAnimate(false);
              setOffset((value) => constrain({ x: value.x + step.x, y: value.y + step.y }, zoom));
            }}
            onPointerDown={(event) => {
              if (event.button !== 0 || drag.current) return;
              event.preventDefault();
              setAnimate(false);
              event.currentTarget.focus({ preventScroll: true });
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, offset };
              setDragging(true);
            }}
            onPointerMove={(event) => {
              const from = drag.current;
              if (!from || from.id !== event.pointerId) return;
              const rect = viewport.current!.getBoundingClientRect();
              setOffset(
                constrain(
                  {
                    x: from.offset.x + (event.clientX - from.x) / rect.width,
                    y: from.offset.y + (event.clientY - from.y) / rect.height,
                  },
                  zoom,
                ),
              );
            }}
            onPointerUp={() => {
              drag.current = null;
              setDragging(false);
            }}
            onPointerCancel={() => {
              if (drag.current) setOffset(drag.current.offset);
              drag.current = null;
              setDragging(false);
            }}
            onLostPointerCapture={() => {
              drag.current = null;
              setDragging(false);
            }}
          />
        )}
      </div>
    </>
  );
}
