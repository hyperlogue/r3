import { useAutoAnimate } from "@formkit/auto-animate/react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyBindings } from "../keys.ts";
import { cn, useEscape } from "../ui.tsx";

// "Jump to file" picker: a toolbar button opening the review's files as a flat,
// filterable list — the fast alternative to the sidebar tree (desktop) and the
// file navigation (mobile, where the sidebar is hidden). The filter input is
// pinned to the bottom, *outside* the scrollable list, so it sits by the thumb —
// and above the keyboard — on a phone. Type to filter, ↑/↓ (or Ctrl-p/Ctrl-n) to
// move the cursor, Enter to open it — so the whole picker is one gesture without
// leaving the keyboard, and Enter still lands on the top match if you never touch
// the arrows. Rows rank unviewed-first (viewed files sink — they're what you're
// done with) and truncate from the *front* (the tail — the basename — is what
// identifies a file), with the basename itself a shade brighter. Desktop anchors the panel
// as a popover under the button; below md the same panel becomes a bottom
// sheet — a pure class fork, so this stays one component with no mobile-module
// import.

function matchFilter(path: string, filter: string): boolean {
  return path.toLowerCase().includes(filter.toLowerCase().trim());
}

function FileRow({
  path,
  viewed,
  current,
  cursor,
  index,
  onSelect,
}: {
  path: string;
  viewed: boolean;
  // The file the pane is already on (the scroll-spy's activePath) — a "you are
  // here" tint, unrelated to what Enter would pick.
  current: boolean;
  // The keyboard cursor: what ↑/↓ moved to and what Enter opens. Distinct from
  // `current` on purpose — the two mean different things and are usually on
  // different rows, so they get different colours (primary vs. neutral) rather
  // than two shades of one.
  cursor: boolean;
  // Position in the match list, so the list can scroll this row into view by
  // query rather than threading a ref through.
  index: number;
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
      data-jtf-row={index}
      aria-current={cursor || undefined}
      className={cn(
        // The left border is always reserved (transparent when it isn't the
        // cursor) so moving the cursor never shifts the rows sideways.
        "flex w-full items-center gap-1.5 rounded border-l-2 border-l-transparent px-1.5 py-1 text-left font-mono text-[0.6875rem] transition-colors max-md:py-2",
        cursor
          ? "border-l-primary-500 bg-primary-100 dark:border-l-primary-400 dark:bg-primary-900/40"
          : current
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
  // The keyboard cursor: an index into `matches`, moved by ↑/↓ (and Ctrl-p/Ctrl-n),
  // opened by Enter. Starts at 0, so Enter without touching the arrows still picks
  // the top match the way it always did.
  const [cursor, setCursor] = useState(0);
  // Unviewed files first (stable within each group): the list is a to-read
  // ranking, and toggling Viewed in the pane re-ranks live (animated below).
  const matches = useMemo(() => {
    const hit = filter.trim() ? files.filter((f) => matchFilter(f, filter)) : files;
    return [...hit.filter((f) => !viewed.has(f)), ...hit.filter((f) => viewed.has(f))];
  }, [files, filter, viewed]);
  // Clamp on READ rather than syncing state to the list: `matches` also shrinks
  // without the filter changing (a file dropped from the review, a live viewed
  // re-rank), and an effect that corrected the index afterwards would leave one
  // render pointing past the end.
  const cursorIdx = matches.length === 0 ? -1 : Math.min(cursor, matches.length - 1);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Add/remove (filtering) and reorder (viewed re-ranking) slide into place.
  const [listRef] = useAutoAnimate<HTMLDivElement>();
  // Typing re-filters — snap the list back to the top, where the cursor has just
  // been reset to, so what Enter will pick is the visible first row.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll position tracks the filter text, not any value read in the effect
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [filter]);
  // Keep the cursor row on screen as it walks past either edge of the scrollport.
  // `block:"nearest"` is what makes this quiet: a row already visible doesn't move
  // the list at all, so arrowing through the middle of a long list scrolls only
  // once the cursor actually reaches an edge.
  useEffect(() => {
    scrollRef.current
      ?.querySelector<HTMLElement>(`[data-jtf-row="${cursorIdx}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [cursorIdx]);
  // ↑/↓ and their Ctrl-p/Ctrl-n aliases (the same pair the feedback list takes,
  // for the same reason — your hand is already on the home row). Clamped, not
  // wrapping, like every other list step in the app.
  //
  // These live on the INPUT, which is where a keyboard is: the picker autofocuses
  // it on any non-coarse pointer, and the global key layer stands down while focus
  // is in a text field, so nothing upstream competes for these presses.
  const onFilterKey = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.metaKey || e.altKey) return; // leave OS/browser chords alone
    if (e.key === "Enter") {
      const pick = matches[cursorIdx];
      if (!pick) return;
      e.preventDefault();
      onSelect(pick);
      return;
    }
    const dir =
      e.key === "ArrowDown" || (e.ctrlKey && e.key === "n")
        ? 1
        : e.key === "ArrowUp" || (e.ctrlKey && e.key === "p")
          ? -1
          : 0;
    if (!dir || matches.length === 0) return;
    // Also stops Ctrl-p printing, and the arrows moving the text caret.
    e.preventDefault();
    // Step from the CLAMPED position, so a cursor left past the end by a shrinking
    // list moves relative to the row that's actually highlighted.
    setCursor((c) => {
      const at = Math.min(c, matches.length - 1);
      return Math.min(matches.length - 1, Math.max(0, at + dir));
    });
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-1.5">
        <div ref={listRef}>
          {matches.map((f, i) => (
            <FileRow
              key={f}
              path={f}
              index={i}
              viewed={viewed.has(f)}
              current={f === activePath}
              cursor={i === cursorIdx}
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
          // Re-filtering re-ranks the list under the cursor, so send it back to
          // the top match — the row the list also scrolls to.
          onChange={(e) => {
            setFilter(e.target.value);
            setCursor(0);
          }}
          onKeyDown={onFilterKey}
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
  useEscape(shown, closePicker);
  // `f` opens the picker (and closes it again). Registered here rather than by the
  // toolbar or ReviewView because open/closed is this component's own state — the
  // binding is a click on the trigger button right above, nothing more. Guarded by
  // `visible` the same way that click is, so a press mid-open-animation doesn't
  // immediately close what it just opened.
  useKeyBindings({ filePicker: () => (shown && visible ? closePicker() : openPicker()) });
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
