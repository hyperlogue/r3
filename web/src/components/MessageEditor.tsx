// Auto-growing textarea with ⌘/Ctrl+Enter submit and Esc cancel. PENDING_INPUT
// is the recessed full-bleed band shared by every composer/reply/edit box.

import { createContext, type RefObject, useContext, useRef } from "react";
import { useAutoGrow } from "../autogrow.ts";
import { cn } from "../ui.tsx";

const PENDING_INPUT =
  "resize-none border-y border-neutral-200 bg-neutral-100 px-3 py-2 text-sm text-neutral-800 outline-none placeholder:text-neutral-400 focus:border-primary-400 max-md:text-base dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-100 dark:placeholder:text-neutral-500";

// Show only the modifier that actually works on this machine: ⌘ on macOS, Ctrl
// elsewhere. The submit handlers accept either (metaKey || ctrlKey) — the hint
// shouldn't make the user pick.
export const SUBMIT_KEYS = (() => {
  const nav = typeof navigator === "undefined" ? null : navigator;
  const platform =
    (nav as (Navigator & { userAgentData?: { platform?: string } }) | null)?.userAgentData
      ?.platform ||
    nav?.platform ||
    "";
  return /mac|iphone|ipad|ipod/i.test(platform) ? "⌘Enter" : "Ctrl+Enter";
})();

// Coarse primary pointer ⇒ almost certainly no hardware keyboard, so the
// keyboard-shortcut hints in composer placeholders (Space/Tab to focus, ⌘Enter,
// Esc) would name keys that don't exist. ReviewView passes the pointer fact in as
// a prop (the panel can't probe it itself — desktop components don't import from
// src/mobile/); a context carries it to the composers, which sit at several
// depths, and this helper builds the placeholder: base prompt alone on touch, base
// + parenthetical hints with a keyboard.
export const CoarsePointerContext = createContext(false);
export function usePlaceholder(base: string, hints: string): string {
  return useContext(CoarsePointerContext) ? base : `${base}  (${hints})`;
}

export function MessageEditor({
  value,
  onChange,
  onSubmit,
  onCancel,
  placeholder,
  disabled,
  autoFocus,
  minRows = 3,
  className,
  textareaRef,
  anchored,
}: {
  value: string;
  onChange: (s: string) => void;
  onSubmit?: () => void;
  onCancel?: () => void;
  placeholder?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  minRows?: number;
  className?: string;
  textareaRef?: RefObject<HTMLTextAreaElement | null>;
  // Tags the textarea so a "Quote in note" click can find + focus it from
  // ReviewView (a different subtree).
  anchored?: boolean;
}) {
  const ownRef = useRef<HTMLTextAreaElement>(null);
  const growRef = useAutoGrow(textareaRef ?? ownRef, value, minRows);
  return (
    <textarea
      ref={growRef}
      data-anchored-composer={anchored ? "" : undefined}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          if (!disabled && value.trim()) onSubmit?.();
        } else if (e.key === "Escape") {
          onCancel?.();
        }
      }}
      placeholder={placeholder}
      // biome-ignore lint/a11y/noAutofocus: editors open on an explicit user action
      autoFocus={autoFocus}
      className={cn(PENDING_INPUT, className)}
    />
  );
}
