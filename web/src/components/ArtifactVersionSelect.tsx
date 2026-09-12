import { useState } from "react";
import type { ArtifactVersion } from "../../../shared/artifacts.ts";
import { selectedArtifactVersion } from "../artifact-version.ts";
import { ChevronDown, cn, useEscape } from "../ui.tsx";

// Keep the original compact version control at the toolbar's right edge.
// Every choice now names a complete publication; there is no live-file entry.
export function ArtifactVersionSelect({
  versions,
  selected,
  onChange,
}: {
  versions: ArtifactVersion[];
  selected: number | null;
  onChange: (seq: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  useEscape(open, () => setOpen(false));
  const version = selectedArtifactVersion(versions, selected);
  const latest = versions.at(-1)?.seq;
  if (!versions.length)
    return <span className="self-center px-3 text-xs text-neutral-500">No published versions</span>;
  const badge = (seq: number, active: boolean) => (
    <span
      className={cn(
        "shrink-0 rounded px-1.5 py-0.5 font-mono text-[0.6875rem] font-semibold",
        active
          ? "bg-primary-100 text-primary-700 dark:bg-primary-950 dark:text-primary-300"
          : "bg-neutral-200 text-neutral-600 dark:bg-neutral-700 dark:text-neutral-300",
      )}
    >
      v{seq}
    </span>
  );
  const latestBadge = (
    <span className="shrink-0 rounded border border-success-500 px-1 py-px text-[0.5625rem] font-semibold uppercase leading-none text-success-700 dark:text-success-300">
      latest
    </span>
  );
  return (
    <div className="relative flex min-w-0 max-md:flex-1">
      <button
        type="button"
        aria-label="Published version"
        aria-haspopup="listbox"
        aria-expanded={open}
        value={version?.seq ?? selected ?? ""}
        data-version-count={versions.length}
        title="Choose a published version"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "flex min-w-0 max-w-[18rem] items-center gap-1.5 border-l border-neutral-300 px-1.5 text-xs text-neutral-600 transition duration-150 hover:bg-neutral-100 max-md:max-w-none max-md:flex-1 max-md:border-l-0 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800",
          open && "opacity-60 grayscale",
        )}
      >
        {version ? badge(version.seq, true) : <span>Version {selected} unavailable</span>}
        {version?.label && <span className="truncate text-neutral-500">{version.label}</span>}
        {version?.seq === latest && latestBadge}
        <ChevronDown
          className={cn(
            "ml-0.5 size-3.5 shrink-0 text-neutral-400 transition-transform max-md:ml-auto",
            open && "rotate-180",
          )}
        />
      </button>
      {open && (
        <button
          type="button"
          aria-label="Close version picker"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 cursor-default"
        />
      )}
      <div
        role="listbox"
        aria-label="Published versions"
        inert={!open}
        className={cn(
          "absolute top-full right-0 z-50 max-h-80 min-w-full overflow-y-auto bg-white shadow-2xl transition-[opacity,transform] duration-150 ease-out max-md:left-0 dark:bg-neutral-800",
          open ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0",
        )}
      >
        {[...versions].reverse().map((item) => (
          <button
            key={item.seq}
            type="button"
            role="option"
            aria-selected={version?.seq === item.seq}
            data-version-seq={item.seq}
            aria-label={`Version ${item.seq}${item.label ? ` · ${item.label}` : ""}`}
            onClick={() => {
              onChange(item.seq);
              setOpen(false);
            }}
            className={cn(
              "flex w-full items-center gap-2 py-1.5 pr-2.5 pl-1.5 text-left text-xs",
              item.seq === version?.seq
                ? "bg-neutral-100 dark:bg-neutral-700"
                : "hover:bg-neutral-50 dark:hover:bg-neutral-700/60",
            )}
          >
            {badge(item.seq, item.seq === version?.seq)}
            <span className="min-w-0 flex-1 truncate whitespace-nowrap text-neutral-600 dark:text-neutral-300">
              {item.label ?? `Version ${item.seq}`}
            </span>
            {item.seq === latest && latestBadge}
          </button>
        ))}
      </div>
    </div>
  );
}
