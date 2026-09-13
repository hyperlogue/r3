import { cn } from "../ui.tsx";

export function ArtifactLoading({
  label = "Loading artifact…",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      role="status"
      aria-label={label}
      className={cn(
        "flex min-h-80 flex-1 flex-col items-center justify-center gap-3 bg-white p-6 text-xs text-neutral-500 dark:bg-neutral-950 dark:text-neutral-400",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="size-8 animate-spin rounded-full border-2 border-neutral-200 border-t-primary-500 motion-reduce:animate-none dark:border-neutral-800 dark:border-t-primary-400"
      />
      <span>{label}</span>
    </div>
  );
}
