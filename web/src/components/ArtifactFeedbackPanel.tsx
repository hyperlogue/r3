import { type ReactNode, useCallback, useRef } from "react";
import type { FeedbackPanelMode } from "../settings.ts";
import { cn, StrokeIcon, useResizableWidth } from "../ui.tsx";
import { type PanelEdge, useFloatingPanel } from "../useFloatingPanel.ts";
import { FeedbackPanelControls } from "./FeedbackPanelControls.tsx";

const edges: [PanelEdge, string][] = [
  ["n", "inset-x-2 -top-1 h-2 cursor-n-resize"],
  ["s", "inset-x-2 -bottom-1 h-2 cursor-s-resize"],
  ["w", "inset-y-2 -left-1 w-2 cursor-w-resize"],
  ["e", "inset-y-2 -right-1 w-2 cursor-e-resize"],
  ["nw", "-top-1 -left-1 size-3 cursor-nw-resize"],
  ["ne", "-top-1 -right-1 size-3 cursor-ne-resize"],
  ["sw", "-bottom-1 -left-1 size-3 cursor-sw-resize"],
  ["se", "-bottom-1 -right-1 size-4 cursor-se-resize"],
];

// Desktop container only. The mobile sheet owns its geometry and gestures.
export function ArtifactFeedbackPanel({
  mode,
  onModeChange,
  children,
}: {
  mode: FeedbackPanelMode;
  onModeChange: (mode: FeedbackPanelMode) => void;
  children: (controls: ReactNode) => ReactNode;
}) {
  const containerRef = useRef<HTMLElement | null>(null);
  const setPanel = useCallback((node: HTMLElement | null) => {
    containerRef.current = node?.parentElement ?? null;
  }, []);
  const dock = useResizableWidth("r3-feedback-width", {
    min: 300,
    max: 700,
    defaultFraction: 0.382,
    containerRef,
  });
  const floating = mode === "floating";
  const hidden = mode === "hidden";
  const pane = useFloatingPanel(containerRef, floating, dock.width);
  const controls = hidden ? null : (
    <>
      {floating && (
        <button
          type="button"
          aria-label="Move feedback"
          title="Drag to move; arrow keys move, Shift moves faster"
          onKeyDown={(event) => pane.key(event)}
          data-feedback-drag
          className="flex size-6 shrink-0 touch-none cursor-grab items-center justify-center rounded text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-200"
        >
          <StrokeIcon className="size-4">
            <path
              d="M9 5h.01M15 5h.01M9 12h.01M15 12h.01M9 19h.01M15 19h.01"
              strokeWidth="3"
              strokeLinecap="round"
            />
          </StrokeIcon>
        </button>
      )}
      <FeedbackPanelControls mode={mode} onChange={onModeChange} />
    </>
  );
  return (
    <aside
      ref={setPanel}
      data-feedback-mode={mode}
      className={cn(
        "border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-950",
        floating
          ? "absolute z-20 rounded-lg border r3-floating [&_[data-feedback-header]]:cursor-grab [&_[data-feedback-header]]:touch-none"
          : hidden
            ? "absolute inset-y-0 right-0 pointer-events-none overflow-hidden"
            : "relative shrink-0 border-l",
        !floating &&
          !dock.dragging &&
          "transition-[width] duration-200 motion-reduce:transition-none",
      )}
      style={
        floating && pane.rect
          ? {
              left: pane.rect.x,
              top: pane.rect.y,
              width: pane.rect.width,
              height: pane.rect.height,
            }
          : { width: hidden ? 0 : dock.width }
      }
      onPointerDown={(event) => {
        const target = event.target as Element;
        if (
          target.closest("[data-feedback-drag]") ||
          (target.closest("[data-feedback-header]") &&
            !target.closest("button, a, input, textarea, select, [role=tab]"))
        )
          pane.start(event);
      }}
    >
      {mode === "expanded" && (
        // biome-ignore lint/a11y/useSemanticElements: interactive adjustable separator, not a thematic break
        <div
          role="separator"
          aria-label="Resize feedback"
          aria-orientation="vertical"
          aria-valuemin={300}
          aria-valuemax={700}
          aria-valuenow={Math.round(dock.width ?? 300)}
          tabIndex={0}
          onPointerDown={dock.onPointerDown}
          onDoubleClick={dock.onDoubleClick}
          onKeyDown={dock.onKeyDown}
          className="absolute inset-y-0 left-0 z-20 w-1 touch-none cursor-col-resize"
        />
      )}
      <div
        inert={hidden}
        className={cn("h-full overflow-hidden", floating && "rounded-[inherit]")}
        style={{
          width: floating ? undefined : dock.width,
          visibility: hidden ? "hidden" : undefined,
        }}
      >
        {children(controls)}
      </div>
      {floating &&
        edges.map(([edge, placement]) => (
          <button
            key={edge}
            type="button"
            tabIndex={edge === "se" ? 0 : -1}
            aria-label={`Resize feedback ${edge}`}
            title={
              edge === "se"
                ? "Drag to resize; arrow keys resize, Shift resizes faster"
                : "Drag to resize; double-click to reset width"
            }
            data-feedback-resize={edge}
            onPointerDown={(event) => pane.start(event, edge)}
            onKeyDown={(event) => pane.key(event, edge)}
            onDoubleClick={pane.resetWidth}
            className={cn("absolute z-30 touch-none", placement)}
          >
            {edge === "se" && (
              <svg
                viewBox="0 0 16 16"
                aria-hidden="true"
                className="pointer-events-none size-3 text-neutral-400"
              >
                <path d="m6 12 6-6m-2 6 2-2" fill="none" stroke="currentColor" />
              </svg>
            )}
          </button>
        ))}
    </aside>
  );
}
