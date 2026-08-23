import { useEffect, useState } from "react";
import {
  type Binding,
  formatChord,
  isBound,
  KEYMAP,
  suspendKeys,
  useKeyBindings,
} from "../keys.ts";
import { cn, useEscape } from "../ui.tsx";

// `?` cheat sheet, rendered from KEYMAP. Owns `help`; suspends every other
// binding while open so `j` doesn't walk the list behind the sheet.

const GROUPS = ["Review", "Feedback", "Files", "View"] as const;

function Key({ chord }: { chord: string }) {
  return (
    <kbd className="inline-flex min-w-5 items-center justify-center rounded border border-neutral-300 border-b-2 bg-neutral-100 px-1.5 py-0.5 font-mono text-[0.6875rem] leading-none text-neutral-700 dark:border-neutral-600 dark:bg-neutral-800 dark:text-neutral-200">
      {formatChord(chord)}
    </kbd>
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
            <Key chord={k} />
          </span>
        ))}
      </span>
    </div>
  );
}

export function ShortcutsOverlay() {
  const [open, setOpen] = useState(false);
  useKeyBindings({ help: () => setOpen((v) => !v) });
  useEscape(open, () => setOpen(false));
  // Hold the suspension for exactly as long as the sheet is up; the release is
  // idempotent, so a StrictMode double-effect can't unbalance the counter.
  useEffect(() => {
    if (!open) return;
    return suspendKeys();
  }, [open]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* backdrop: a real button so a click anywhere outside closes it */}
      <button
        type="button"
        aria-label="Close"
        onClick={() => setOpen(false)}
        className="absolute inset-0 cursor-default bg-black/30"
      />
      <div className="relative max-h-full w-full max-w-lg overflow-y-auto rounded-lg border border-neutral-300 bg-white p-4 shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
        <div className="mb-3 flex items-baseline justify-between gap-2">
          <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
            Keyboard shortcuts
          </h2>
          <span className="text-[0.6875rem] text-neutral-400">Esc to close</span>
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
          Anchoring feedback to a line range is a mouse gesture — drag in the code, or
          click-and-drag the line numbers. Shortcuts stand down while you're typing.
        </p>
      </div>
    </div>
  );
}
