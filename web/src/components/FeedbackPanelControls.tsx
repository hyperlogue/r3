import type { FeedbackPanelMode } from "../settings.ts";
import { StrokeIcon } from "../ui.tsx";

const control =
  "flex size-6 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100";

export function FeedbackPanelControls({
  mode,
  onChange,
}: {
  mode: Exclude<FeedbackPanelMode, "hidden">;
  onChange: (mode: FeedbackPanelMode) => void;
}) {
  const next = mode === "floating" ? "expanded" : "floating";
  const label = next === "expanded" ? "Dock feedback" : "Float feedback";
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        aria-label={label}
        title={label}
        onClick={() => onChange(next)}
        className={control}
      >
        <StrokeIcon className="size-4">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          {next === "expanded" ? (
            <path d="M14 4v16M16 8h2M16 12h2" />
          ) : (
            <rect x="10" y="10" width="8" height="7" rx="1" />
          )}
        </StrokeIcon>
      </button>
      <button
        type="button"
        aria-label="Hide feedback"
        title="Hide feedback (p)"
        onClick={() => onChange("hidden")}
        className={control}
      >
        <StrokeIcon className="size-4">
          <path d={mode === "expanded" ? "m9 6 6 6-6 6" : "m6 6 12 12M6 18 18 6"} />
        </StrokeIcon>
      </button>
    </div>
  );
}
