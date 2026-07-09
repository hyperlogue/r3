// Row virtualization for the code panes (FileView / DiffView). A review pane is
// ONE vertical scroll container stacking N files, each with its OWN horizontal
// scroll and its own fold — so this is one virtualizer PER FILE, all pointed at
// the shared pane as their scroll element via a measured `scrollMargin` (the
// file's offset within the pane). Only the on-screen window of rows (+ overscan)
// is mounted, cutting a thousand-line file from ~1900 rows to ~90.
//
// Layout is spacer-based (a top pad, the live rows in normal flow, a bottom pad)
// rather than absolute positioning, so the existing `min-w-max` wrapper keeps
// driving each file's horizontal scroll extent from its widest *mounted* line —
// no manual width bookkeeping. Rows are measured (`measureElement`) because a
// diff interleaves slightly-taller hunk separators among the code rows.
//
// The ReviewView content pane wraps its children in <VirtualPaneProvider>, which
// hands down the scroll element, a `layoutVersion` that bumps when the stacked
// height changes (a fold/unfold/font change shifts every lower file's
// scrollMargin), and a scroll-to-line registry so ReviewView's locate/pin jumps
// can bring a virtualized-away row on screen before highlighting it.

import { useVirtualizer } from "@tanstack/react-virtual";
import {
  createContext,
  Fragment,
  type ReactNode,
  type RefObject,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useFontSize } from "./settings.ts";
import type { DiffSide } from "./types.ts";

// Files with fewer rows than this render in full — the mounted window of a
// virtualized file is already ~viewport + 2·overscan rows, so virtualizing a
// short file saves nothing and only adds spacer machinery. Comfortably above the
// window so virtualization only kicks in where it actually pays.
const VIRTUALIZE_MIN = 150;
const OVERSCAN = 24;
// Where a scrolled-to line lands in the pane: 30% down, matching ReviewView's
// SCROLL_RATIO so a virtualized jump and a DOM-scroll jump feel the same.
const LINE_SCROLL_RATIO = 0.3;

export interface ScrollToLineOpts {
  align?: "start" | "center" | "end";
}
// Bring `line` (on `side`, for diffs) into view within its file. Returns false
// when the file isn't virtualized / the line isn't in this list, so the caller
// can fall back to its DOM-based scroll.
export type ScrollToLineFn = (
  line: number,
  side: DiffSide | null,
  opts?: ScrollToLineOpts,
) => boolean;

export type ScrollToLine = (
  key: string,
  line: number,
  side: DiffSide | null,
  opts?: ScrollToLineOpts,
) => boolean;

interface VirtualPaneValue {
  scrollRef: RefObject<HTMLElement | null>;
  // Bumped whenever the stacked content height changes (fold, font size, file
  // membership) — every file below the change has a new scrollMargin.
  layoutVersion: number;
  register: (key: string, fn: ScrollToLineFn | null) => void;
}

const VirtualPaneContext = createContext<VirtualPaneValue | null>(null);

// A scroll-to-line registry the PANE OWNER holds (not the provider): the owner
// (ReviewView) renders the provider as a child, so its own locate/pin jumps run
// above the provider and can't consume its context — instead it owns the
// registry here and hands it to the provider. `scrollToLine(key, …)` reaches a
// virtualized file's row that querySelector would otherwise miss (unmounted).
export function useVirtualPaneController(): {
  registry: RefObject<Map<string, ScrollToLineFn>>;
  scrollToLine: ScrollToLine;
} {
  const registry = useRef(new Map<string, ScrollToLineFn>());
  const scrollToLine = useCallback<ScrollToLine>(
    (key, line, side, opts) => registry.current.get(key)?.(line, side, opts) ?? false,
    [],
  );
  return { registry, scrollToLine };
}

// Wrap the scroll pane's children. `scrollRef` is the pane (the vertical scroll
// container); `registry` is the owner's scroll-to-line map. This observes the
// wrapped content's height so folds/resizes flow out as a layoutVersion bump.
export function VirtualPaneProvider({
  scrollRef,
  registry,
  children,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  registry: RefObject<Map<string, ScrollToLineFn>>;
  children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [layoutVersion, setLayoutVersion] = useState(0);

  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    // The wrapped content's box height = the stacked files' total height. It's
    // invariant while scrolling (each file's container is a fixed totalSize), so
    // this only fires on a real layout change — a fold, a font-size change, a
    // membership edit — exactly when scrollMargins move.
    const ro = new ResizeObserver(() => setLayoutVersion((v) => v + 1));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const register = useCallback(
    (key: string, fn: ScrollToLineFn | null) => {
      if (fn) registry.current.set(key, fn);
      else registry.current.delete(key);
    },
    [registry],
  );

  const value = useMemo<VirtualPaneValue>(
    () => ({ scrollRef, layoutVersion, register }),
    [scrollRef, layoutVersion, register],
  );
  return (
    <VirtualPaneContext.Provider value={value}>
      <div ref={contentRef}>{children}</div>
    </VirtualPaneContext.Provider>
  );
}

// The registry key for a file's virtualizer: the round seq (diff rounds can
// repeat a path) + the path. Kept in one place so the provider and callers agree.
export function fileScrollKey(patchSeq: number | null | undefined, file: string): string {
  return `${patchSeq ?? ""}:${file}`;
}

// Virtualize a file's rows. `renderRow(index)` renders the caller's own row
// (LineRow / diff Row) unchanged; `itemKey` gives each a stable React key so the
// sliding window reconciles cleanly. `resolveIndex(line, side)` maps a source
// line to this list's row index for scroll-to-line (default: index === line-1,
// the files-view case). Renders every row (no windowing) when there's no pane
// (Storybook), the pane hasn't mounted, or the file is short.
export function VirtualLines({
  count,
  itemKey,
  renderRow,
  className,
  scrollKey,
  resolveIndex,
}: {
  count: number;
  itemKey: (index: number) => string | number;
  renderRow: (index: number) => ReactNode;
  className?: string;
  scrollKey?: string;
  resolveIndex?: (line: number, side: DiffSide | null) => number | null;
}) {
  const pane = useContext(VirtualPaneContext);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const fontSize = useFontSize();

  // The scroll element only exists after the pane commits, so read it into state
  // (a null→element transition then re-renders us and flips on virtualization).
  const [scrollEl, setScrollEl] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setScrollEl(pane?.scrollRef.current ?? null);
  }, [pane]);

  const enabled = !!pane && !!scrollEl && count >= VIRTUALIZE_MIN;

  const [scrollMargin, setScrollMargin] = useState(0);
  // Re-measure the file's offset within the pane whenever layout above it could
  // have moved: a fold/resize (layoutVersion), a font-size change, or a change in
  // this file's own row count. Cheap (two rects + scrollTop), never on scroll.
  // layoutVersion/fontSize/count are intentional re-measure triggers, not read here.
  // biome-ignore lint/correctness/useExhaustiveDependencies: layout/font/count are re-measure triggers
  useLayoutEffect(() => {
    if (!enabled) return;
    const c = containerRef.current;
    const s = scrollEl;
    if (!c || !s) return;
    const m = c.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop;
    setScrollMargin((prev) => (Math.abs(prev - m) > 0.5 ? m : prev));
  }, [enabled, scrollEl, pane?.layoutVersion, fontSize, count]);

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollEl,
    // Every row is one mono line whose height is text-xs's 1rem line-height = the
    // root font size, so a FIXED size is exact for all of them (callers keep their
    // rows uniform — a diff's hunk separator is sized like a code row). Deliberately
    // NO measureElement: measuring a row while its file is folded (clipped inside a
    // 0-height Collapse) reports a bogus height and poisons scrollToIndex.
    estimateSize: () => fontSize,
    overscan: OVERSCAN,
    scrollMargin,
    getItemKey: itemKey,
  });

  // Register scroll-to-line so ReviewView can reach a virtualized-away row.
  useEffect(() => {
    if (!pane || !scrollKey) return;
    if (!enabled) {
      pane.register(scrollKey, null);
      return;
    }
    const fn: ScrollToLineFn = (line, side) => {
      const idx = resolveIndex ? resolveIndex(line, side) : line - 1;
      if (idx == null || idx < 0 || idx >= count) return false;
      const c = containerRef.current;
      const s = scrollEl;
      if (!c || !s) return false;
      // Compute the row's content offset from the container's LIVE position
      // (getBoundingClientRect + scrollTop) plus idx·rowHeight, and scroll the
      // pane there ourselves. Deliberately NOT virtualizer.scrollToIndex /
      // getOffsetForIndex: those read the virtualizer's internal scrollMargin,
      // which lags during a fold/unfold and sent the jump wildly off. The live
      // rect is always right, so re-issuing this each frame (see ReviewView)
      // converges as an unfolding file settles. Land the line ~30% down the pane.
      const rowTop = c.getBoundingClientRect().top - s.getBoundingClientRect().top + s.scrollTop;
      const target = rowTop + idx * fontSize - s.clientHeight * LINE_SCROLL_RATIO;
      s.scrollTo({ top: Math.max(0, target) });
      return true;
    };
    pane.register(scrollKey, fn);
    return () => pane.register(scrollKey, null);
  }, [pane, scrollKey, enabled, resolveIndex, count, scrollEl, fontSize]);

  if (!enabled) {
    return (
      <div ref={containerRef} className={className}>
        {Array.from({ length: count }, (_, i) => (
          <Fragment key={itemKey(i)}>{renderRow(i)}</Fragment>
        ))}
      </div>
    );
  }

  const items = virtualizer.getVirtualItems();
  const total = virtualizer.getTotalSize();
  // Spacer heights are LOCAL to this container (virtualItem.start/end are measured
  // from the scroll origin and include scrollMargin, so subtract it back out).
  const topPad = items.length ? items[0].start - scrollMargin : 0;
  const bottomPad = items.length ? total - (items[items.length - 1].end - scrollMargin) : total;

  return (
    <div ref={containerRef} className={className}>
      <div aria-hidden style={{ height: topPad }} />
      {items.map((vi) => (
        // Fixed-size rows, so no measure wrapper — the caller's row (already
        // min-w-full) renders straight into the flow between the spacers.
        <Fragment key={vi.key}>{renderRow(vi.index)}</Fragment>
      ))}
      <div aria-hidden style={{ height: bottomPad }} />
    </div>
  );
}
