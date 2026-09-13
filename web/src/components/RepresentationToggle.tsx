import { cn, StrokeIcon } from "../ui.tsx";

export function RepresentationToggle({
  value,
  onChange,
}: {
  value: "source" | "rendered";
  onChange: (value: "source" | "rendered") => void;
}) {
  return (
    <div className="flex shrink-0 overflow-hidden rounded text-[0.625rem] ring-1 ring-inset ring-neutral-300 pointer-coarse:self-stretch dark:ring-neutral-700">
      {(["source", "rendered"] as const).map((mode) => (
        <button
          key={mode}
          type="button"
          aria-pressed={value === mode}
          title={mode === "source" ? "Source" : "Rendered"}
          className={cn(
            "flex items-center justify-center px-1.5 py-0.5 font-medium transition-colors max-md:min-w-7 pointer-coarse:min-w-7",
            value === mode
              ? "bg-neutral-200 text-neutral-800 dark:bg-neutral-700 dark:text-neutral-100"
              : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800",
          )}
          onClick={(event) => {
            event.stopPropagation();
            onChange(mode);
          }}
        >
          <span className="max-md:sr-only">{mode === "source" ? "Source" : "Rendered"}</span>
          <StrokeIcon className="hidden size-3.5 max-md:block">
            {mode === "source" ? (
              <path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16" />
            ) : (
              <>
                <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z" />
                <circle cx="12" cy="12" r="3" />
              </>
            )}
          </StrokeIcon>
        </button>
      ))}
    </div>
  );
}
