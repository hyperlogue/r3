import type { ReactNode } from "react";

// Lucide-style stroked glyphs for the pane toolbar (24 viewBox, like
// FoldChevrons in ui.tsx). `d` takes several paths for the two-chevron pairs.
function ToolbarIcon({ d }: { d: string[] }) {
  return (
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
      {d.map((p) => (
        <path key={p} d={p} />
      ))}
    </svg>
  );
}

// The toolbar's icon-button treatment — exported for widgets composed into its
// slots (ReviewView's JumpToFile trigger) so they match the native buttons.
export const TOOLBAR_BTN =
  "flex rounded p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200";

// Sticky strip above the file pane: jump to the previous/next file block and
// fold/unfold every file at once (icon-only; the titles carry the words), plus
// an optional right-docked slot for the multi-round diff switcher. The file
// buttons hide when there are no files (an empty diff round still shows the strip
// so its round switcher stays reachable).
export function PaneToolbar({
  hasFiles,
  filePicker,
  onJump,
  onFoldAll,
  right,
  summary,
}: {
  hasFiles: boolean;
  // The jump-to-file picker, composed by the caller (a slot, like `right`) so
  // its data wiring stays with the owner of that data instead of threading four
  // pass-through props here.
  filePicker?: ReactNode;
  onJump: (dir: 1 | -1) => void;
  onFoldAll: (mode: "fold" | "unfold") => void;
  right?: ReactNode;
  // Mobile only (ReviewView passes it only below md): the active round's summary
  // as the stacked bar's middle row — between the switcher and the buttons.
  summary?: ReactNode;
}) {
  // h-8 matches the file header height so the file pane's two stacked bars (this
  // toolbar + each file header) read as one consistent header stack. Intra-panel
  // only — we deliberately DON'T match the feedback panel's bars across the split
  // (equal heights there read as one connected bar); those keep their own heights.
  // Below md one row is too crowded, so the bar wraps into rows: the round/snapshot
  // switcher first at full width (`order-first` + `w-full` under the flex-wrap),
  // then the round summary (also order-first — later in the DOM, so it lands
  // second), then the buttons left-aligned — with no switcher/summary those rows
  // simply never exist.
  return (
    <div className="flex h-8 shrink-0 items-center border-b border-neutral-300 bg-white px-1.5 max-md:h-auto max-md:flex-wrap dark:border-neutral-700 dark:bg-neutral-950">
      {hasFiles && (
        <div className="flex items-center max-md:h-8">
          <button
            type="button"
            title="Previous file"
            className={TOOLBAR_BTN}
            onClick={() => onJump(-1)}
          >
            <ToolbarIcon d={["m18 15-6-6-6 6"]} />
          </button>
          <button type="button" title="Next file" className={TOOLBAR_BTN} onClick={() => onJump(1)}>
            <ToolbarIcon d={["m6 9 6 6 6-6"]} />
          </button>
          <div className="mx-1 h-4 w-px bg-neutral-200 dark:bg-neutral-800" />
          <button
            type="button"
            title="Fold all files"
            className={TOOLBAR_BTN}
            onClick={() => onFoldAll("fold")}
          >
            <ToolbarIcon d={["m7 20 5-5 5 5", "m7 4 5 5 5-5"]} />
          </button>
          <button
            type="button"
            title="Unfold all files"
            className={TOOLBAR_BTN}
            onClick={() => onFoldAll("unfold")}
          >
            <ToolbarIcon d={["m7 15 5 5 5-5", "m7 9 5-5 5 5"]} />
          </button>
          <div className="mx-1 h-4 w-px bg-neutral-200 dark:bg-neutral-800" />
          {filePicker}
        </div>
      )}
      {/* Full-height, flush-right slot: `self-stretch` fills the bar's height and
          `-mr-1.5` cancels the toolbar's horizontal padding, so an embedded widget
          (the round switcher) reaches the bar's top/bottom/right edges. On mobile
          it becomes the full-width first row instead. */}
      {right && (
        <div className="-mr-1.5 ml-auto flex items-stretch self-stretch max-md:order-first max-md:-ml-1.5 max-md:h-8 max-md:w-[calc(100%+0.75rem)] max-md:border-b max-md:border-neutral-300 max-md:dark:border-neutral-700">
          {right}
        </div>
      )}
      {/* Full-bleed like the switcher row (cancel the bar's px-1.5); the summary
          block carries its own padding + bottom border. order-first ties with the
          switcher row and DOM order breaks the tie, so this lands between it and
          the buttons. */}
      {summary && (
        <div className="-ml-1.5 -mr-1.5 w-[calc(100%+0.75rem)] max-md:order-first">{summary}</div>
      )}
    </div>
  );
}
