import { useRef } from "react";
import { t, useLocale } from "../i18n.ts";
import { type Binding, formatChord, isBound, KEYMAP, useKeyBindings } from "../keys.ts";
import { cn, StrokeIcon, useEscape, usePopoverFocus } from "../ui.tsx";
import { HeaderIconButton } from "./WorkspaceHeader.tsx";

// `?` cheat sheet, rendered from KEYMAP. Owns `help`; suspends every other
// binding while open so `j` doesn't walk the list behind the sheet.

const GROUPS = ["Review", "Thread", "Files", "View"] as const;

export function ShortcutsButton({ onClick }: { onClick: () => void }) {
  useLocale();
  return (
    <HeaderIconButton
      aria-label={t("Keyboard shortcuts")}
      aria-haspopup="dialog"
      title={t("Keyboard shortcuts (?)")}
      onClick={onClick}
    >
      <StrokeIcon className="size-4">
        <rect x="2" y="5" width="20" height="14" rx="2" />
        <path d="M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 12h.01M10 12h.01M14 12h.01M18 12h.01M8 15h8" />
      </StrokeIcon>
    </HeaderIconButton>
  );
}

function ShortcutKey({ chord }: { chord: string }) {
  return (
    <kbd className="inline-flex min-w-4 shrink-0 items-center justify-center rounded border border-neutral-200 bg-neutral-50 px-1 py-0.5 font-mono text-[0.625rem] font-normal leading-none text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400">
      {formatChord(chord)}
    </kbd>
  );
}

// `bound` = some component currently owns this id. A key that doesn't apply to
// the view on screen (`\` with no diff, `<`/`>` in a single-round review, `x`
// where viewed isn't tracked) registers no handler and does nothing — so dim it
// rather than listing it as if it were live.
function Row({ b, bound }: { b: Binding; bound: boolean }) {
  useLocale();
  return (
    <div className={cn("flex items-baseline justify-between gap-4 py-1", !bound && "opacity-40")}>
      <span className="text-xs text-neutral-600 dark:text-neutral-300">{t(b.label)}</span>
      {/* The first chord is the documented primary; the rest are aliases, joined by
          a thin "or" so nobody reads `j Ctrl-n` as a two-key sequence. */}
      <span className="flex shrink-0 items-center gap-1">
        {b.keys.map((k, i) => (
          <span key={k} className="flex items-center gap-1">
            {i > 0 && <span className="text-[0.625rem] text-neutral-400">{t("or")}</span>}
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
  useLocale();
  const content = useRef<HTMLDivElement>(null);
  useKeyBindings({ help: () => onOpenChange(!open) });
  useEscape(open, () => onOpenChange(false));
  usePopoverFocus(open, content);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* backdrop: a real button so a click anywhere outside closes it */}
      <button
        type="button"
        aria-label={t("Close")}
        onClick={() => onOpenChange(false)}
        className="absolute inset-0 cursor-default bg-black/30"
      />
      <div
        ref={content}
        role="dialog"
        aria-label={t("Keyboard shortcuts")}
        tabIndex={-1}
        className="relative max-h-full w-full max-w-lg overflow-y-auto rounded-lg border border-neutral-300 bg-white p-4 r3-modal dark:border-neutral-700 dark:bg-neutral-900"
      >
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
            {t("Keyboard shortcuts")}
          </h2>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            aria-label={t("Close keyboard shortcuts")}
            title={t("Close keyboard shortcuts (Esc)")}
            className="flex items-center gap-1.5 text-[0.6875rem] text-neutral-500 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200"
          >
            {t("Close")}
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
              <section key={t(g)} className="mb-4 break-inside-avoid">
                <h3 className="mb-1 text-[0.625rem] font-semibold uppercase tracking-wide text-neutral-400">
                  {t(g)}
                </h3>
                <div className="divide-y divide-neutral-100 dark:divide-neutral-800">
                  {rows.map((b) => (
                    <Row key={b.id} b={b} bound={isBound(b.id)} />
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
          {t(
            "Anchoring threads to a line range is a mouse gesture — drag in the code, or click-and-drag the line numbers. Shortcuts stand down while you're typing.",
          )}
        </p>
      </div>
    </div>
  );
}
