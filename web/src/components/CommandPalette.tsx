import { type KeyboardEvent, useId, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "../i18n.ts";
import {
  formatChord,
  KEYMAP,
  type KeyId,
  runKeyAction,
  useBoundKeys,
  useKeyBindings,
} from "../keys.ts";
import { StrokeIcon, useEscape, usePopoverFocus } from "../ui.tsx";
import { HeaderIconButton } from "./WorkspaceHeader.tsx";

const GROUPS = [
  { id: "Review", label: "common.review" },
  { id: "Thread", label: "threadPopover.thread" },
  { id: "Files", label: "common.files" },
  { id: "View", label: "common.view" },
] as const;

export function CommandPaletteButton({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation();
  return (
    <HeaderIconButton
      aria-label={t("commandPalette.title")}
      aria-haspopup="dialog"
      title={t("commandPalette.openShortcut")}
      onClick={onClick}
    >
      <StrokeIcon className="size-4">
        <path d="M9 7V4.5A2.5 2.5 0 1 0 6.5 7H17.5A2.5 2.5 0 1 0 15 4.5v15a2.5 2.5 0 1 0 2.5-2.5H6.5A2.5 2.5 0 1 0 9 19.5V7Z" />
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

function PaletteContent({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const content = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const bound = useBoundKeys();
  const titleId = useId();
  const listId = useId();
  useEscape(true, onClose);
  usePopoverFocus(true, content);

  const terms = query.toLocaleLowerCase().trim().split(/\s+/);
  const matches = KEYMAP.filter((binding) => {
    if (binding.id === "help") return false;
    const text =
      `${t(binding.label)} ${binding.keys.map(formatChord).join(" ")}`.toLocaleLowerCase();
    return terms.every((term) => text.includes(term));
  });
  const run = (id: KeyId) => {
    if (!bound.has(id)) return;
    // Keep this in the user gesture for clipboard actions, but finish restoring
    // focus before a command opens another overlay or focuses a composer.
    flushSync(onClose);
    runKeyAction(id);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Tab") {
      const controls = content.current?.querySelectorAll<HTMLElement>(
        "input, button:not(:disabled)",
      );
      const first = controls?.[0];
      const last = controls?.[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === "Enter" && event.target === search.current) {
      event.preventDefault();
      const first = matches.find((binding) => bound.has(binding.id));
      if (first && !event.repeat) run(first.id);
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const rows = Array.from(
      content.current?.querySelectorAll<HTMLButtonElement>("[data-command]:not(:disabled)") ?? [],
    );
    if (!rows.length) return;
    const current =
      document.activeElement instanceof HTMLButtonElement
        ? rows.indexOf(document.activeElement)
        : -1;
    const next =
      event.key === "ArrowDown"
        ? (current + 1) % rows.length
        : (current < 0 ? rows.length - 1 : current - 1 + rows.length) % rows.length;
    rows[next]?.focus();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        tabIndex={-1}
        aria-label={t("common.close")}
        onClick={onClose}
        className="absolute inset-0 cursor-default bg-black/30"
      />
      <div
        ref={content}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="relative flex max-h-[min(80dvh,42rem)] w-full max-w-lg flex-col overflow-hidden rounded-lg border border-neutral-300 bg-white r3-modal dark:border-neutral-700 dark:bg-neutral-900"
      >
        <div className="shrink-0 border-b border-neutral-200 p-3 dark:border-neutral-700">
          <h2
            id={titleId}
            className="mb-2 text-xs font-semibold text-neutral-800 dark:text-neutral-100"
          >
            {t("commandPalette.title")}
          </h2>
          <div className="flex items-center gap-2">
            <StrokeIcon className="size-4 shrink-0 text-neutral-400">
              <circle cx="10.5" cy="10.5" r="6.5" />
              <path d="m16 16 4 4" />
            </StrokeIcon>
            <input
              ref={search}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label={t("commandPalette.search")}
              aria-controls={listId}
              placeholder={t("commandPalette.search")}
              className="min-w-0 flex-1 bg-transparent py-1 text-sm text-neutral-800 outline-none placeholder:text-neutral-400 max-md:text-base dark:text-neutral-100"
            />
            <button
              type="button"
              onClick={onClose}
              aria-label={t("commandPalette.close")}
              title={t("commandPalette.closeShortcut")}
              className="flex size-7 shrink-0 items-center justify-center rounded text-neutral-500 hover:bg-neutral-100 hover:text-neutral-800 max-md:size-9 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            >
              <StrokeIcon className="size-4">
                <path d="m6 6 12 12M18 6 6 18" />
              </StrokeIcon>
            </button>
          </div>
        </div>
        <div id={listId} className="min-h-0 overflow-y-auto overscroll-contain p-1.5">
          {GROUPS.map(({ id, label }) => {
            const rows = matches.filter((binding) => binding.group === id);
            if (!rows.length) return null;
            return (
              <section key={id} aria-label={t(label)} className="mb-2 last:mb-0">
                <h3 className="px-2 py-1.5 text-[0.625rem] font-semibold uppercase tracking-wide text-neutral-400">
                  {t(label)}
                </h3>
                {rows.map((binding) => (
                  <button
                    key={binding.id}
                    type="button"
                    data-command={binding.id}
                    disabled={!bound.has(binding.id)}
                    title={!bound.has(binding.id) ? t("commandPalette.unavailable") : undefined}
                    onClick={() => run(binding.id)}
                    className="flex w-full items-center justify-between gap-4 px-2 py-2 text-left text-xs text-neutral-700 hover:bg-neutral-100 focus:bg-neutral-100 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent max-md:min-h-10 dark:text-neutral-200 dark:hover:bg-neutral-800 dark:focus:bg-neutral-800 dark:disabled:hover:bg-transparent"
                  >
                    <span>{t(binding.label)}</span>
                    <span className="flex shrink-0 items-center gap-1">
                      {binding.keys.map((key, index) => (
                        <span key={key} className="flex items-center gap-1">
                          {index > 0 && (
                            <span className="text-[0.625rem] text-neutral-400">
                              {t("commandPalette.or")}
                            </span>
                          )}
                          <ShortcutKey chord={key} />
                        </span>
                      ))}
                    </span>
                  </button>
                ))}
              </section>
            );
          })}
          {!matches.length && (
            <p
              role="status"
              className="px-2 py-8 text-center text-xs text-neutral-500 dark:text-neutral-400"
            >
              {t("commandPalette.noResults")}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-neutral-200 px-3 py-2 text-[0.625rem] text-neutral-500 dark:border-neutral-700 dark:text-neutral-400">
          <span className="flex items-center gap-1">
            <ShortcutKey chord="↑" />
            <ShortcutKey chord="↓" />
            {t("commandPalette.navigate")}
          </span>
          <span className="flex items-center gap-1">
            <ShortcutKey chord="Enter" />
            {t("commandPalette.run")}
          </span>
          <span className="ml-auto flex items-center gap-1">
            <ShortcutKey chord="Escape" />
            {t("common.close")}
          </span>
        </div>
      </div>
    </div>
  );
}

export function CommandPalette({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  useKeyBindings({ help: () => onOpenChange(!open) });
  return open ? <PaletteContent onClose={() => onOpenChange(false)} /> : null;
}
