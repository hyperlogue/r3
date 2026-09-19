import { useId, useLayoutEffect, useRef, useState } from "react";
import type { ArtifactVersion } from "../../../shared/artifacts.ts";
import { selectedArtifactVersion } from "../artifact-version.ts";
import { Button, ChevronDown, cn, useEscape, usePopoverFocus } from "../ui.tsx";

// The compact navigation picker expands inline when hosted in the details menu.
export function ArtifactVersionSelect({
  versions,
  selected,
  onChange,
  inline = false,
}: {
  versions: ArtifactVersion[];
  selected: number | null;
  onChange: (seq: number | null) => void;
  inline?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(selected);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [position, setPosition] = useState({ left: 0, top: 0 });
  useEscape(open, () => setOpen(false));
  usePopoverFocus(open, list, trigger);
  useLayoutEffect(() => {
    if (!open || inline) return;
    const place = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const width = list.current!.getBoundingClientRect().width;
      setPosition({
        left: Math.max(8, Math.min(rect.left, innerWidth - width - 8)),
        top: rect.bottom,
      });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open, inline]);
  const version = selectedArtifactVersion(versions, selected);
  if (!versions.length)
    return <span className="self-center px-3 text-xs text-neutral-500">No published versions</span>;
  const isLatest = version?.seq === versions.at(-1)?.seq;
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
  return (
    <div className={cn("relative flex min-w-0", inline && "w-full flex-col")}>
      <button
        ref={trigger}
        type="button"
        aria-label="Published version"
        aria-describedby={isLatest ? `${listId}-latest` : undefined}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        value={version?.seq ?? selected ?? ""}
        data-version-count={versions.length}
        title="Choose a published version"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
        className={cn(
          "flex min-w-0 items-center gap-1.5 px-2 py-1 text-xs text-neutral-600 transition duration-150 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800",
          inline ? "w-full rounded max-md:min-h-9" : "max-w-[18rem] self-stretch",
          open && "opacity-60 grayscale",
        )}
      >
        {version ? badge(version.seq, true) : <span>Version {selected} unavailable</span>}
        {isLatest && (
          <span
            id={`${listId}-latest`}
            role="status"
            aria-label="Latest version"
            className="shrink-0 rounded border border-success-500 px-1 py-px text-[0.5625rem] font-semibold uppercase leading-none text-success-700 dark:text-success-300"
          >
            latest
          </span>
        )}
        <ChevronDown
          className={cn(
            "ml-auto size-3.5 shrink-0 text-neutral-400 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open && !inline && (
        <button
          type="button"
          aria-label="Close version picker"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 cursor-default"
        />
      )}
      <div
        ref={list}
        id={listId}
        role="listbox"
        aria-label="Published versions"
        inert={!open}
        style={inline ? undefined : position}
        onKeyDown={(event) => {
          const options = Array.from(
            event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'),
          );
          const current = options.indexOf(document.activeElement as HTMLButtonElement);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? options.length - 1
                : event.key === "ArrowDown"
                  ? (current + 1) % options.length
                  : event.key === "ArrowUp"
                    ? (current - 1 + options.length) % options.length
                    : null;
          if (next !== null) {
            event.preventDefault();
            options[next]?.focus();
          }
        }}
        className={cn(
          "max-h-80 overflow-y-auto rounded border border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-950",
          inline
            ? cn("mt-1 w-full", !open && "hidden")
            : cn(
                "fixed z-50 w-72 max-w-[calc(100vw-1rem)] r3-popover transition-[opacity,transform] duration-150 ease-out",
                open ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-1 opacity-0",
              ),
        )}
      >
        {[...versions].reverse().map((item) => (
          <button
            key={item.seq}
            type="button"
            role="option"
            aria-selected={version?.seq === item.seq}
            tabIndex={focused === item.seq ? 0 : -1}
            onFocus={() => setFocused(item.seq)}
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
          </button>
        ))}
      </div>
    </div>
  );
}

export function ArtifactOpenLatest({
  latest,
  selected,
  onOpen,
  className,
}: {
  latest: number | undefined;
  selected: number | null;
  onOpen: (seq: number) => void;
  className?: string;
}) {
  if (latest === undefined || selected === null || selected === latest) return null;
  return (
    <Button
      variant="warning-outline"
      className={cn("shrink-0 whitespace-nowrap", className)}
      onClick={() => onOpen(latest)}
    >
      Go to the latest version
    </Button>
  );
}
