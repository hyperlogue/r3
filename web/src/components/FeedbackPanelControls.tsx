import type { FeedbackPanelMode } from "../settings.ts";
import { cn, FoldChevrons } from "../ui.tsx";

const labels: Record<FeedbackPanelMode, string> = {
  hidden: "Hide feedback",
  expanded: "Expand feedback",
  floating: "Float feedback",
};

export function FeedbackPanelControls({
  mode,
  onChange,
}: {
  mode: FeedbackPanelMode;
  onChange: (mode: FeedbackPanelMode) => void;
}) {
  return (
    <fieldset
      aria-label="Feedback panel"
      className={cn("flex shrink-0 items-center", mode === "hidden" && "flex-col")}
    >
      {(["expanded", "floating", "hidden"] as const)
        .filter((next) => next !== mode)
        .map((next) => (
          <button
            key={next}
            type="button"
            aria-label={labels[next]}
            title={labels[next]}
            onClick={() => onChange(next)}
            className="flex size-[24px] shrink-0 items-center justify-center rounded text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
          >
            {next === "hidden" ? (
              <FoldChevrons dir="right" />
            ) : (
              <svg
                aria-hidden="true"
                className="size-4"
                viewBox="0 0 20 20"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                {next === "expanded" ? (
                  <>
                    <rect x="2" y="3" width="16" height="14" rx="2" />
                    <path d="M12 3v14" />
                  </>
                ) : (
                  <>
                    <path d="M7 14H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    <rect x="7" y="7" width="11" height="10" rx="2" />
                  </>
                )}
              </svg>
            )}
          </button>
        ))}
    </fieldset>
  );
}
