import { formatChord, KEYMAP, type KeyId } from "../keys.ts";

export function ShortcutKey({ chord }: { chord: string }) {
  return (
    <kbd className="inline-flex min-w-4 shrink-0 items-center justify-center rounded border border-neutral-200 bg-neutral-50 px-1 py-0.5 font-mono text-[0.625rem] font-normal leading-none text-neutral-500 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-400">
      {formatChord(chord)}
    </kbd>
  );
}

// Keep hints out of action names and touch layouts. The same map owns dispatch,
// the full sheet, and these primary-key hints.
export function ShortcutHint({ id }: { id: KeyId }) {
  const binding = KEYMAP.find((binding) => binding.id === id)!;
  return (
    <span aria-hidden="true" className="inline-flex max-md:hidden">
      <ShortcutKey chord={binding.keys[0]!} />
    </span>
  );
}
