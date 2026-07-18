import { useAutoAnimate } from "@formkit/auto-animate/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "../ui.tsx";

// "Jump to file" picker: a toolbar button opening the review's files as a flat,
// filterable list — the fast alternative to the sidebar tree (desktop) and the
// file navigation (mobile, where the sidebar is hidden). The filter input is
// pinned to the bottom, *outside* the scrollable list, so it sits by the thumb —
// and above the keyboard — on a phone; Enter jumps to the top match. Rows rank
// unviewed-first (viewed files sink — they're what you're done with) and
// truncate from the *front* (the tail — the basename — is what identifies a
// file), with the basename itself a shade brighter. Desktop anchors the panel
// as a popover under the button; below md the same panel becomes a bottom
// sheet — a pure class fork, so this stays one component with no mobile-module
// import.

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
  const cut = path.lastIndexOf("/") + 1;
  const dir = path.slice(0, cut);
  const base = path.slice(cut);
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
        viewed
          ? "text-neutral-400 dark:text-neutral-500"
          : "text-neutral-500 dark:text-neutral-400",
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
      {/* One gapless path container (the ✓'s gap-1.5 applies once, to it — so a
          root-level file with no dir span keeps the same left edge as everyone).
          Front-truncation: the dir span is RTL so the ellipsis lands on the LEFT
          while the inner LTR embed keeps the path reading normally. The basename
          sits outside the clip (shrink-0) so it always survives whole, and its
          brightness boost is *relative* in both states — a viewed row dims as a
          whole but its basename still leads its directory. */}
      <span className="flex min-w-0 items-center">
        {dir && (
          <span className="min-w-0 shrink truncate text-left [direction:rtl]">
            <span className="[direction:ltr] [unicode-bidi:embed]">{dir}</span>
          </span>
        )}
        <span
          className={cn(
            "shrink-0 font-medium",
            viewed
              ? "text-neutral-500 dark:text-neutral-400"
              : "text-neutral-800 dark:text-neutral-200",
          )}
        >
          {base}
        </span>
      </span>
    </button>
  );
}

// The panel's inner content — scrollable match list over a bottom-pinned filter
// input. Exported on its own so a host other than the popover button (e.g. a
// custom sheet) can embed the same list. `onShrink` (mobile) renders a collapse
// button beside the filter so the sheet can be dismissed without picking a file.
export function JumpToFileList({
  files,
  viewed,
  activePath,
  onSelect,
  autoFocus,
  onShrink,
}: {
  files: string[];
  viewed: Set<string>;
  activePath: string | null;
  onSelect: (path: string) => void;
  autoFocus?: boolean;
  onShrink?: () => void;
}) {
  const [filter, setFilter] = useState("");
  // Unviewed files first (stable within each group): the list is a to-read
  // ranking, and toggling Viewed in the pane re-ranks live (animated below).
  const matches = useMemo(() => {
    const hit = filter.trim() ? files.filter((f) => matchFilter(f, filter)) : files;
    return [...hit.filter((f) => !viewed.has(f)), ...hit.filter((f) => viewed.has(f))];
  }, [files, filter, viewed]);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Add/remove (filtering) and reorder (viewed re-ranking) slide into place.
  const [listRef] = useAutoAnimate<HTMLDivElement>();
  // Typing re-filters — snap the list back to the top so the top match (what
  // Enter will pick) is the visible first row.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll position tracks the filter text, not any value read in the effect
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [filter]);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
        <div ref={listRef}>
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
      </div>
      <div className="flex shrink-0 items-center border-t border-neutral-200 bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-800/60">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && matches.length > 0) onSelect(matches[0]);
          }}
          placeholder="Filter files…"
          // biome-ignore lint/a11y/noAutofocus: the picker opens on an explicit click; focus goes where typing goes (desktop only — on touch, focus would pop the keyboard over the list)
          autoFocus={autoFocus}
          className="min-w-0 flex-1 bg-transparent px-3 py-2 font-mono text-xs text-neutral-800 outline-none placeholder:text-neutral-400 max-md:py-2.5 max-md:text-base dark:text-neutral-100 dark:placeholder:text-neutral-500"
        />
        {onShrink && (
          <button
            type="button"
            aria-label="Close file list"
            onClick={onShrink}
            className="hidden shrink-0 items-center justify-center self-stretch px-3 text-neutral-400 max-md:flex"
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
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        )}
      </div>
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
  // Two-phase visibility so close animates before unmount: `shown` mounts the
  // panel, `visible` drives the transition (desktop: fade+scale from the button
  // corner; mobile sheet: slide up from the bottom edge — a different motion for
  // a different layout). Mount → next frame flips visible so the entry
  // transition actually runs. Unmount does NOT trust transitionend — mobile
  // Safari drops it often enough that the invisible full-screen backdrop was
  // left swallowing every tap — so closing always arms a timer a beat past the
  // 150ms transition, with transitionend as the fast path.
  const [shown, setShown] = useState(false);
  const [visible, setVisible] = useState(false);
  const unmountTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const openPicker = () => {
    if (unmountTimer.current != null) clearTimeout(unmountTimer.current);
    setShown(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
  };
  const closePicker = () => {
    setVisible(false);
    if (unmountTimer.current != null) clearTimeout(unmountTimer.current);
    unmountTimer.current = setTimeout(() => setShown(false), 250);
  };
  useEffect(() => () => clearTimeout(unmountTimer.current ?? undefined), []);
  const closeRef = useRef(closePicker);
  closeRef.current = closePicker;
  useEffect(() => {
    if (!shown) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shown]);
  const pick = (path: string) => {
    closePicker();
    onSelect(path);
  };
  return (
    <div className="relative">
      <button
        type="button"
        title="Jump to file"
        onClick={() => (shown && visible ? closePicker() : openPicker())}
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
      {shown && (
        <>
          {/* Click-away backdrop (SettingsPopup's pattern); below md it dims —
              fading with the sheet — since the panel covers the page there. */}
          <button
            type="button"
            aria-label="Close"
            onClick={closePicker}
            className={cn(
              "fixed inset-0 z-40 cursor-default transition-opacity duration-150 max-md:bg-black/30",
              // While animating out (and in any state where the panel isn't
              // interactive) the backdrop must not intercept taps — a lingering
              // invisible layer here is a dead page.
              !visible && "pointer-events-none opacity-0",
            )}
          />
          {/* Desktop: popover under the button (clear of the toolbar's edge),
              half again wider than the old w-72 so deep paths breathe. Below md:
              the same panel pinned to the bottom edge as a sheet (fixed escapes
              the toolbar's overflow) at a *fixed* height estimate capped by dvh —
              the cap absorbs the keyboard shrinking dvh, the estimate keeps the
              sheet from resizing the moment the filter focuses. */}
          <div
            onTransitionEnd={() => {
              if (!visible) setShown(false);
            }}
            className={cn(
              "absolute left-0 top-full z-50 mt-2.5 flex h-80 w-[27rem] origin-top-left flex-col overflow-hidden rounded-lg border border-neutral-300 bg-white shadow-xl transition-[transform,opacity] duration-150 ease-out max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:top-auto max-md:mt-0 max-md:h-[24rem] max-md:max-h-[80dvh] max-md:w-auto max-md:origin-bottom max-md:rounded-b-none dark:border-neutral-700 dark:bg-neutral-950",
              visible
                ? "scale-100 opacity-100 max-md:translate-y-0"
                : "pointer-events-none scale-95 opacity-0 max-md:translate-y-full max-md:scale-100 max-md:opacity-100",
            )}
          >
            <JumpToFileList
              files={files}
              viewed={viewed}
              activePath={activePath}
              onSelect={pick}
              autoFocus={!window.matchMedia("(pointer: coarse)").matches}
              onShrink={closePicker}
            />
          </div>
        </>
      )}
    </div>
  );
}
