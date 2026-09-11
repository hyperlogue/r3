import type { ArtifactVersion } from "../../../shared/artifacts.ts";
import { selectedArtifactVersion, stepArtifactVersion } from "../artifact-version.ts";
import { Button } from "../ui.tsx";

export function ArtifactVersionSelect({
  versions,
  selected,
  onChange,
}: {
  versions: ArtifactVersion[];
  selected: number | null;
  onChange: (seq: number | null) => void;
}) {
  const version = selectedArtifactVersion(versions, selected);
  if (!versions.length)
    return <span className="text-xs text-neutral-500">No published versions</span>;
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Button
        title="Previous published version"
        aria-label="Previous published version"
        disabled={!version || version.seq === versions[0].seq}
        onClick={() => onChange(stepArtifactVersion(versions, selected, -1))}
      >
        ‹
      </Button>
      <select
        aria-label="Published version"
        className="min-w-0 rounded border border-neutral-300 bg-transparent px-2 py-1 text-xs max-md:text-base dark:border-neutral-700"
        value={version?.seq ?? selected ?? ""}
        onChange={(event) => onChange(Number(event.target.value))}
      >
        {!version && <option value={selected ?? ""}>Version {selected} unavailable</option>}
        {versions.map((item) => (
          <option key={item.seq} value={item.seq}>
            Version {item.seq}
            {item.label ? ` · ${item.label}` : ""}
            {item.seq === versions.at(-1)!.seq ? " (latest)" : ""}
          </option>
        ))}
      </select>
      <Button
        title="Next published version"
        aria-label="Next published version"
        disabled={!version || version.seq === versions.at(-1)!.seq}
        onClick={() => onChange(stepArtifactVersion(versions, selected, 1))}
      >
        ›
      </Button>
    </div>
  );
}
