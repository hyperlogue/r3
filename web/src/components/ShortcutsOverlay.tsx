import { useRef } from "react";
import { type Binding, KEYMAP, type KeyId, useBoundKeys, useKeyBindings } from "../keys.ts";
import { cn, StrokeIcon, useEscape, usePopoverFocus } from "../ui.tsx";
import { ShortcutKey } from "./ShortcutHint.tsx";
import { HeaderIconButton } from "./WorkspaceHeader.tsx";

// `?` cheat sheet, rendered from KEYMAP. Owns `help`; suspends every other
// binding while open so `j` doesn't walk the list behind the sheet.

const GROUPS = ["Review", "Thread", "Files", "View"] as const;

export function ShortcutsButton({ onClick }: { onClick: () => void }) {
  return (
    <HeaderIconButton
      aria-label="Keyboard shortcuts"
      aria-haspopup="dialog"
      title="Keyboard shortcuts (?)"
      onClick={onClick}
    >
      <StrokeIcon className="size-4">
        <rect x="2" y="5" width="20" height="14" rx="2" />
        <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 15h8" />
      </StrokeIcon>
    </HeaderIconButton>
  );
}

export function ShortcutBar({
  onOpen,
  threadSelected,
  readOnly,
}: {
  onOpen: () => void;
  threadSelected: boolean;
  readOnly: boolean;
}) {
  const bound = useBoundKeys();
  const hints: { ids: KeyId[]; label: string }[] = [];
  if (bound.includes("fbNext")) {
    hints.push({ ids: ["fbNext", "fbPrev"], label: "Navigate threads" });
    if (!readOnly) {
      if (threadSelected) hints.push({ ids: ["fbComment"], label: "Reply" });
      else hints.push({ ids: ["generalNote"], label: "Add comment" });
    }
  } else if (bound.includes("fileNext")) {
    hints.push({ ids: ["filePrev", "fileNext"], label: "Navigate files" });
  }
  if (bound.includes("filePicker")) hints.push({ ids: ["filePicker"], label: "Jump to file" });
  else if (bound.includes("panelToggle"))
    hints.push({ ids: ["panelToggle"], label: "Toggle discussion" });
  return (
    <div
      data-shortcut-bar
      className="flex h-7 shrink-0 items-center justify-between gap-4 border-t border-neutral-200 bg-white px-3 text-[0.625rem] text-neutral-500 max-md:hidden dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-400"
    >
      <div className="flex min-w-0 items-center gap-5">
        {hints
          .filter((hint) => hint.ids.every((id) => bound.includes(id)))
          .map((hint) => (
            <span key={hint.label} className="flex items-center gap-1.5 whitespace-nowrap">
              <span className="flex items-center gap-0.5">
                {hint.ids.map((id) => (
                  <ShortcutKey key={id} chord={KEYMAP.find((b) => b.id === id)!.keys[0]!} />
                ))}
              </span>
              {hint.label}
            </span>
          ))}
      </div>
      <button
        type="button"
        onClick={onOpen}
        aria-haspopup="dialog"
        className="flex shrink-0 items-center gap-1.5 self-stretch hover:text-neutral-800 dark:hover:text-neutral-200"
      >
        <ShortcutKey chord="?" />
        All shortcuts
      </button>
    </div>
  );
}

// `bound` = some component currently owns this id. A key that doesn't apply to
// the view on screen (`\` with no diff, `<`/`>` in a single-round review, `x`
// where viewed isn't tracked) registers no handler and does nothing — so dim it
// rather than listing it as if it were live.
function Row({ b, bound }: { b: Binding; bound: boolean }) {
  return (
    <div className={cn("flex items-baseline justify-between gap-4 py-1", !bound && "opacity-40")}>
      <span className="text-xs text-neutral-600 dark:text-neutral-300">{b.label}</span>
      {/* The first chord is the documented primary; the rest are aliases, joined by
          a thin "or" so nobody reads `j Ctrl-n` as a two-key sequence. */}
      <span className="flex shrink-0 items-center gap-1">
        {b.keys.map((k, i) => (
          <span key={k} className="flex items-center gap-1">
            {i > 0 && <span className="text-[0.625rem] text-neutral-400">or</span>}
            <ShortcutKey chord={k} />
          </span>
        ))}
      </span>
    </div>
  );
}

export function ShortcutsOverlay({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const content = useRef<HTMLDivElement>(null);
  const bound = useBoundKeys();
  useKeyBindings({ help: () => onOpenChange(!open) });
  useEscape(open, () => onOpenChange(false));
  usePopoverFocus(open, content);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* backdrop: a real button so a click anywhere outside closes it */}
      <button
        type="button"
        aria-label="Close"
        onClick={() => onOpenChange(false)}
        className="absolute inset-0 cursor-default bg-black/30"
      />
      <div
        ref={content}
        role="dialog"
        aria-label="Keyboard shortcuts"
        tabIndex={-1}
        className="relative max-h-full w-full max-w-lg overflow-y-auto rounded-lg border border-neutral-300 bg-white p-4 r3-modal dark:border-neutral-700 dark:bg-neutral-900"
      >
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label="Close keyboard shortcuts"
            className="flex items-center gap-1.5 text-[0.6875rem] text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
          >
            Close <ShortcutKey chord="Escape" />
          </button>
        </div>
        {/* Two columns on a roomy sheet, one on a narrow one. `columns` (not grid)
            so a group is never split across a column break — break-inside on the
            group does that for free, which a grid can't express as cheaply. */}
        <div className="sm:columns-2 sm:gap-6">
          {GROUPS.map((g) => {
            const rows = KEYMAP.filter((b) => b.group === g);
            if (rows.length === 0) return null;
            return (
              <section key={g} className="mb-4 break-inside-avoid">
                <h3 className="mb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-neutral-400">
                  {g}
                </h3>
                <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {rows.map((b) => (
                    <Row key={b.id} b={b} bound={bound.includes(b.id)} />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
        {/* The one thing the table can't say: what ISN'T bound, and why. Selecting a
            line range stays a mouse gesture by design, and someone hunting the map
            for it should find the answer here rather than concluding it's missing. */}
        <p className="mt-1 border-t border-neutral-200 pt-3 text-[0.6875rem] leading-relaxed text-neutral-500 dark:border-neutral-800 dark:text-neutral-400">
          Anchoring threads to a line range is a mouse gesture — drag in the code, or click-and-drag
          the line numbers. Shortcuts stand down while you're typing.
        </p>
      </div>
    </div>
  );
}
