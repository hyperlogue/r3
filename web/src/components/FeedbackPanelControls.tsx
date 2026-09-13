import type { FeedbackPanelMode } from "../settings.ts";
import { StrokeIcon } from "../ui.tsx";

export function FeedbackPanelControls({
  mode,
  onChange,
}: {
  mode: Exclude<FeedbackPanelMode, "hidden">;
  onChange: (mode: FeedbackPanelMode) => void;
}) {
  const next = mode === "floating" ? "expanded" : "floating";
  const label = next === "expanded" ? "Expand feedback" : "Float feedback";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={() => onChange(next)}
      className="flex size-[24px] shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
    >
      <StrokeIcon className="size-4">
        {next === "expanded" ? (
          <>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M14 4v16" />
          </>
        ) : (
          <>
            <path d="M8 17H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v2" />
            <rect x="8" y="8" width="13" height="12" rx="2" />
          </>
        )}
      </StrokeIcon>
    </button>
  );
}
