import { memo, useMemo } from "react";
import {
  type EnterHandler,
  GUTTER_SELECTED,
  type GutterHandler,
  inSelection,
  useGutterDrag,
} from "../gutter.ts";
import { type Region, regionAt } from "../highlights.ts";
import type { DiffSide, RenderedFileLine } from "../types.ts";
import { cn, useHtml } from "../ui.tsx";
import { fileScrollKey, VirtualLines } from "../virtual.tsx";

// Stable primitive props keep gutter drags from rendering unaffected rows.
const LineRow = memo(function LineRow({
  ln,
  selected,
  onDown,
  onEnter,
  fbId,
}: {
  ln: RenderedFileLine;
  selected: boolean;
  onDown: GutterHandler;
  onEnter: EnterHandler;
  fbId?: string;
}) {
  // Stable `{__html}` wrapper so React 19 doesn't re-set innerHTML (wiping a
  // selection) when the row re-renders on a gutter `selected` flip.
  const html = useHtml(ln.html || "&nbsp;");
  return (
    <div
      // Below md the single 3.5rem gutter compresses to 2.5rem (with px tightened
      // to 1) to give the code more of a phone's width; a 4-digit line number
      // still fits. The gutter pins at left-0, so there's no derived left offset to
      // follow (unlike DiffView's two-column new-side pin).
      className={cn(
        "grid min-w-full grid-cols-[3.5rem_1fr] font-mono text-xs max-md:grid-cols-[2.5rem_1fr]",
        fbId && "r3-feedback-region",
      )}
      data-line={ln.lineNo}
      data-side="new"
      data-fb-id={fbId}
    >
      <span
        data-gutter
        className={cn(
          // Frozen line-number rail: sticky so only the code scrolls
          // horizontally. Must stay opaque — the code slides under it —
          // and painted on the theme surface so it matches the code bg.
          // touch-manipulation so a tap-to-anchor never registers as a double-tap zoom.
          "sticky left-0 z-0 cursor-pointer touch-manipulation border-r border-neutral-300/70 px-2 text-right text-neutral-400 select-none hover:text-neutral-700 max-md:px-1 dark:border-neutral-700 dark:hover:text-neutral-200",
          selected ? GUTTER_SELECTED : "gutter-surface",
        )}
        onMouseDown={(e) => onDown("new", ln.lineNo, e)}
        onMouseEnter={() => onEnter("new", ln.lineNo)}
      >
        {ln.lineNo}
      </span>
      <code className="shiki-code px-2 whitespace-pre" dangerouslySetInnerHTML={html} />
    </div>
  );
});

export function SourceCode({
  data,
  path,
  onPickLines,
  regions,
  scrollKey,
}: {
  data: { lines: RenderedFileLine[] };
  path: string;
  onPickLines: (side: DiffSide, lineStart: number, lineEnd: number, quote: string) => void;
  regions: Region[];
  scrollKey?: string;
}) {
  const g = useGutterDrag({
    textForLine: (_side, n) => data.lines[n - 1]?.text ?? null,
    onPick: (p) => onPickLines(p.side, p.lineStart, p.lineEnd, p.quote),
  });
  const sel = g.selection;
  const fileRegions = useMemo(
    () => (regions.length === 0 ? regions : regions.filter((r) => r.file === path)),
    [regions, path],
  );
  return (
    <div className="shiki-surface overflow-x-auto">
      {/* One horizontal scrollbar per file: rows share a max-content wrapper (so it
          grows to the widest MOUNTED line) and each row is min-w-full (so short rows
          span the full scroll width). VirtualLines mounts only the on-screen window;
          a files review's lines are contiguous from 1, so index === lineNo - 1 (the
          default resolveIndex) drives scroll-to-line. See DiffView for the same. */}
      <VirtualLines
        className="min-w-max"
        count={data.lines.length}
        itemKey={(i) => data.lines[i].lineNo}
        scrollKey={scrollKey ?? fileScrollKey(null, path)}
        renderRow={(i) => {
          const ln = data.lines[i];
          return (
            <LineRow
              ln={ln}
              selected={inSelection(sel, "new", ln.lineNo)}
              onDown={g.onDown}
              onEnter={g.onEnter}
              fbId={regionAt(fileRegions, ln.lineNo, "new")?.id}
            />
          );
        }}
      />
    </div>
  );
}
