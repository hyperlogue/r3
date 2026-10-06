import type { ComparisonSide } from "../components/ArtifactComparison.tsx";
import { Button } from "../ui.tsx";

// Only the phone container selects one preview. Both documents stay mounted.
export function MobileComparisonTabs({
  side,
  onChange,
}: {
  side: ComparisonSide;
  onChange: (side: ComparisonSide) => void;
}) {
  return (
    <fieldset
      aria-label="Comparison view"
      className="flex shrink-0 gap-1 border-b border-neutral-300 p-1 dark:border-neutral-700"
    >
      {(["original", "proposed"] as const).map((value) => (
        <Button
          key={value}
          className="flex-1 justify-center"
          variant={side === value ? "primary-outline" : "ghost"}
          aria-pressed={side === value}
          onClick={() => onChange(value)}
        >
          {value === "original" ? "Original" : "Proposed fix"}
        </Button>
      ))}
    </fieldset>
  );
}
