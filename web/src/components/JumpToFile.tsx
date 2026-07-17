import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../ui.tsx";

// "Jump to file" picker: a toolbar button opening the review's files as a flat,
// filterable list — the fast alternative to the sidebar tree (desktop) and the
// file navigation (mobile, where the sidebar is hidden). The filter input is
// pinned to the bottom, *outside* the scrollable list, so it sits by the thumb —
// and above the keyboard — on a phone; Enter jumps to the top match. Viewed
// files wear the sidebar's ✓-and-dimmed treatment. Desktop anchors the panel as
// a popover under the button; below md the same panel becomes a bottom sheet —
// a pure class fork, so this stays one component with no mobile-module import.

function matchFilter(path: string, filter: string): boolean {
  return path.toLowerCase().includes(filter.toLowerCase().trim());
}

function FileRow({
  path,
  viewed,
  active,
  onSelect,
}: {
  path: string;
  viewed: boolean;
  active: boolean;
  onSelect: (p: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(path)}
      title={path}
      className={cn(
        "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left font-mono text-[0.6875rem] transition-colors max-md:py-2",
        active
          ? "bg-neutral-200/70 dark:bg-neutral-800"
          : "hover:bg-neutral-100 dark:hover:bg-neutral-800/60",
        viewed && "text-neutral-400 dark:text-neutral-500",
      )}
    >
      <span
        className={cn(
          "w-2 shrink-0 text-[0.5625rem]",
          viewed ? "text-success-600 dark:text-success-400" : "text-transparent",
        )}
      >
        ✓
      </span>
      <span className="truncate">{path}</span>
    </button>
  );
}

// The panel's inner content — scrollable match list over a bottom-pinned filter
// input. Exported on its own so a host other than the popover button (e.g. a
// custom sheet) can embed the same list.
export function JumpToFileList({
  files,
  viewed,
  activePath,
  onSelect,
  autoFocus,
}: {
  files: string[];
  viewed: Set<string>;
  activePath: string | null;
  onSelect: (path: string) => void;
  autoFocus?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const matches = useMemo(
    () => (filter.trim() ? files.filter((f) => matchFilter(f, filter)) : files),
    [files, filter],
  );
  const listRef = useRef<HTMLDivElement>(null);
  // Typing re-filters — snap the list back to the top so the top match (what
  // Enter will pick) is the visible first row.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll position tracks the filter text, not any value read in the effect
  useEffect(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, [filter]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {matches.map((f) => (
          <FileRow
            key={f}
            path={f}
            viewed={viewed.has(f)}
            active={f === activePath}
            onSelect={onSelect}
          />
        ))}
        {matches.length === 0 && (
          <div className="px-1.5 py-2 text-xs text-neutral-400">No files match</div>
        )}
      </div>
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && matches.length > 0) onSelect(matches[0]);
        }}
        placeholder="Filter files…"
        // biome-ignore lint/a11y/noAutofocus: the picker opens on an explicit click; focus goes where typing goes (desktop only — on touch, focus would pop the keyboard over the list)
        autoFocus={autoFocus}
        className="w-full shrink-0 border-t border-neutral-200 bg-neutral-100 px-3 py-2 font-mono text-xs text-neutral-800 outline-none placeholder:text-neutral-400 focus:border-primary-400 max-md:py-2.5 max-md:text-base dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-100 dark:placeholder:text-neutral-500"
      />
    </div>
  );
}

export function JumpToFile({
  files,
  viewed,
  activePath,
  onSelect,
  btnClassName,
}: {
  files: string[];
  viewed: Set<string>;
  activePath: string | null;
  onSelect: (path: string) => void;
  // The host toolbar's button style, so the trigger sits flush with its siblings.
  btnClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  const pick = (path: string) => {
    setOpen(false);
    onSelect(path);
  };
  return (
    <div className="relative">
      <button
        type="button"
        title="Jump to file"
        onClick={() => setOpen((v) => !v)}
        className={btnClassName}
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-4"
        >
          {/* Lucide "file-search": document sheet + a magnifier in its body. */}
          <path d="M14 2v4a2 2 0 0 0 2 2h4" />
          <path d="M4.268 21a2 2 0 0 0 1.727 1H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v3" />
          <path d="m9 18-1.5-1.5" />
          <circle cx="5" cy="14" r="3" />
        </svg>
      </button>
      {open && (
        <>
          {/* Click-away backdrop (SettingsPopup's pattern); below md it dims, since
              the panel there is a sheet over the whole page. */}
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default max-md:bg-black/30"
          />
          {/* Desktop: popover under the button. Below md: the same panel pinned to
              the bottom edge as a sheet (fixed escapes the toolbar's overflow). */}
          <div className="absolute left-0 top-full z-50 mt-1 flex h-80 w-72 flex-col overflow-hidden rounded-lg border border-neutral-300 bg-white shadow-xl max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:top-auto max-md:mt-0 max-md:h-[60dvh] max-md:w-auto max-md:rounded-b-none dark:border-neutral-700 dark:bg-neutral-950">
            <JumpToFileList
              files={files}
              viewed={viewed}
              activePath={activePath}
              onSelect={pick}
              autoFocus={!window.matchMedia("(pointer: coarse)").matches}
            />
          </div>
        </>
      )}
    </div>
  );
}
