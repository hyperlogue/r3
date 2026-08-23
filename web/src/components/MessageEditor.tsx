// Auto-growing textarea with ⌘/Ctrl+Enter submit and Esc cancel. PENDING_INPUT
// is the recessed full-bleed band shared by every composer/reply/edit box.

import { type RefObject, useRef } from "react";
import { useAutoGrow } from "../autogrow.ts";
import { cn } from "../ui.tsx";

const PENDING_INPUT =
  "resize-none border-y border-neutral-200 bg-neutral-100 px-3 py-2 text-sm text-neutral-800 outline-none placeholder:text-neutral-400 focus:border-primary-400 max-md:text-base dark:border-neutral-700 dark:bg-neutral-800/60 dark:text-neutral-100 dark:placeholder:text-neutral-500";

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
