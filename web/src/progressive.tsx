// Large-review body hydration: one observer, measured offscreen shells.
// Inactive files keep measured height so scroll-spy and jumps keep geometry.

import {
  type CSSProperties,
  createContext,
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

// Small reviews are cheaper and simpler rendered eagerly. Past this point the
// number of concurrent blob requests / per-file virtualizers becomes the larger
// cost, so progressively hydrate file bodies instead.
export const PROGRESSIVE_FILES_MIN = 24;

// A diff round arrives as ONE payload, so file count alone is the wrong gate for
// it: a round is often a handful of files carrying thousands of rows, and what a
// scroll pass costs is the compositor's display-list walk over the MOUNTED
// nodes — it scales with what is rendered, not with the payload or the damage.
// Past this many rendered rows a round defers its offscreen bodies too. ~2000
// rows is >20k DOM nodes, several times what the pane can show at once, so most
// of that walk is for content nobody is looking at; below it the placeholder
// machinery costs more than it saves.
export const PROGRESSIVE_ROWS_MIN = 2000;

// The fallback for a shell whose caller computed no ReserveSpec (Storybook, the
// demo, any caller with no line counts): enough provisional height that the
// initially compact set of shells does not all enter the preload band before the
// first blobs land. A caller that CAN say how tall its file is should — see
// ReserveSpec.
const INITIAL_HEIGHT = "16rem";
const FOLDED_HEIGHT = "2rem"; // FileCard's protected h-8 header.
const PRELOAD_MARGIN_PX = 1000;

// FileCard's protected h-8 header, and the r3-markdown wrapper's py-3. Both in
// rem, because the whole layout is rem-scaled off the font-size setting.
const HEADER_REM = 2;
const MD_PAD_REM = 1.5;
// A file with no body to render — gone from the source, binary, over the cap —
// is its path row plus one line of notice in a p-3 panel. An expected state on a
// long-lived review whose branch moved on, so it gets a real reserve rather than
// the fallback's 16rem.
const CHROME_REM = 2.5;

// Rendered px per source line for a markdown body, before this review has
// measured one. Rendered markdown is the one body whose height does NOT follow
// from its source — no row grid, and the wrapping depends on the pane's width —
// so it is estimated and then corrected: the provider learns the real ratio from
// the cards it measures (see useMdRatio). The seed only has to survive the first
// screen.
const MD_RATIO_SEED = 1.6;

// How tall a deferred file block will be once it mounts.
//
// This exists because "how tall is a file I haven't fetched?" decides the scroll
// pane's own height, and therefore the scrollbar: a shell that guesses makes the
// pane grow under the reader every time a real body lands, which is what a flat
// 16rem placeholder did on a 200-file review (an order of magnitude short, and
// then wrong in the other direction for every file big enough to auto-fold).
//
// Two of the three cases are exact, not estimates. A `folded` card is only ever
// its header — auto-fold, or already viewed — and an open code card is its rows
// at the same fixed line height VirtualLines assumes. Only rendered markdown is
// an estimate; `lines` still scales it with the file, which a per-review mean
// never could.
export type ReserveSpec =
  | { folded: true }
  | { folded: false; kind: "code"; rows: number }
  | { folded: false; kind: "markdown"; lines: number }
  | { folded: false; kind: "chrome" };

export function reservePx(spec: ReserveSpec, fontSize: number, mdRatio: number): number {
  const header = HEADER_REM * fontSize;
  if (spec.folded) return header;
  if (spec.kind === "chrome") return header + CHROME_REM * fontSize;
  if (spec.kind === "code") return header + spec.rows * fontSize;
  return header + MD_PAD_REM * fontSize + spec.lines * fontSize * mdRatio;
}

// The px-per-source-line ratio for THIS review's rendered markdown, learned from
// every markdown card the provider has measured. Weighted by line count rather
// than averaged per file, because what the reserve is feeding is a total: a
// 2000-line doc should count for more than a 20-line one.
//
// Published only when it moves materially — every change re-renders every shell,
// and the value converges after a couple of files. Small files are skipped
// entirely: their height is mostly chrome, so they carry almost no signal about
// the ratio and plenty of noise.
const MD_SAMPLE_MIN_LINES = 8;
const MD_RATIO_EPSILON = 0.1;

function useMdRatio(fontSize: number): {
  ratio: number;
  sample: (spec: ReserveSpec, height: number) => void;
} {
  const totals = useRef({ px: 0, lines: 0 });
  const [ratio, setRatio] = useState(MD_RATIO_SEED);
  const sample = useCallback(
    (spec: ReserveSpec, height: number) => {
      if (spec.folded || spec.kind !== "markdown" || spec.lines < MD_SAMPLE_MIN_LINES) return;
      const body = height - (HEADER_REM + MD_PAD_REM) * fontSize;
      if (body <= 0) return;
      const t = totals.current;
      t.px += body;
      t.lines += spec.lines;
      const next = t.px / t.lines / fontSize;
      setRatio((prev) => (Math.abs(next - prev) / prev > MD_RATIO_EPSILON ? next : prev));
    },
    [fontSize],
  );
  return { ratio, sample };
}

type OnReady = () => void;
type ActivateFile = (onReady?: OnReady) => void;

export function useProgressiveFileController(): {
  registry: RefObject<Map<string, ActivateFile>>;
  activate: (path: string, onReady?: OnReady) => boolean;
} {
  const registry = useRef(new Map<string, ActivateFile>());
  const activate = useCallback((path: string, onReady?: OnReady) => {
    const fn = registry.current.get(path);
    fn?.(onReady);
    return !!fn;
  }, []);
  return { registry, activate };
}

interface ObservedFile {
  onNear: (near: boolean) => void;
  onResize: (height: number) => void;
}

interface ProgressiveContextValue {
  enabled: boolean;
  registry: RefObject<Map<string, ActivateFile>>;
  observe: (el: HTMLElement, file: ObservedFile) => () => void;
}

const ProgressiveContext = createContext<ProgressiveContextValue | null>(null);

// The rem→px scale a ReserveSpec resolves against, plus this review's learned
// markdown ratio — held by the provider so there is one font-size subscription
// and one learner for the whole stack, not one per file.
//
// Deliberately a SECOND context: the ratio moves as cards are measured, and the
// observer registration above must not be torn down and re-established every
// time it does.
interface ReserveScale {
  fontSize: number;
  mdRatio: number;
  sample: (spec: ReserveSpec, height: number) => void;
}

const ReserveContext = createContext<ReserveScale | null>(null);

// Own the ONE IntersectionObserver + ONE ResizeObserver for every file shell.
// Per-file observers would recreate the same fan-out this component exists to
// remove. Registrations may arrive before the provider effect constructs the
// observers, so the map is authoritative and gets replayed at construction.
export function ProgressiveFileProvider({
  scrollRef,
  registry,
  enabled,
  children,
}: {
  scrollRef: RefObject<HTMLElement | null>;
  registry: RefObject<Map<string, ActivateFile>>;
  enabled: boolean;
  children: ReactNode;
}) {
  const files = useRef(new Map<HTMLElement, ObservedFile>());
  const intersection = useRef<IntersectionObserver | null>(null);
  const resize = useRef<ResizeObserver | null>(null);
  const fontSize = useFontSize();
  const { ratio: mdRatio, sample } = useMdRatio(fontSize);

  const observe = useCallback((el: HTMLElement, file: ObservedFile) => {
    files.current.set(el, file);
    intersection.current?.observe(el);
    resize.current?.observe(el);
    return () => {
      intersection.current?.unobserve(el);
      resize.current?.unobserve(el);
      files.current.delete(el);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const root = scrollRef.current;
    if (!root) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          files.current.get(entry.target as HTMLElement)?.onNear(entry.isIntersecting);
        }
      },
      { root, rootMargin: `${PRELOAD_MARGIN_PX}px 0px` },
    );
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // The shell itself has no padding or border, so contentRect is the
        // height we need and avoids the older Safari borderBoxSize variants.
        files.current.get(entry.target as HTMLElement)?.onResize(entry.contentRect.height);
      }
    });
    intersection.current = io;
    resize.current = ro;
    for (const el of files.current.keys()) {
      io.observe(el);
      ro.observe(el);
    }
    return () => {
      io.disconnect();
      ro.disconnect();
      intersection.current = null;
      resize.current = null;
    };
  }, [enabled, scrollRef]);

  const value = useMemo(() => ({ enabled, registry, observe }), [enabled, registry, observe]);
  const scale = useMemo(() => ({ fontSize, mdRatio, sample }), [fontSize, mdRatio, sample]);
  return (
    <ProgressiveContext.Provider value={value}>
      <ReserveContext.Provider value={scale}>{children}</ReserveContext.Provider>
    </ProgressiveContext.Provider>
  );
}

// One stable file block in the review stack. Its render prop receives whether
// the expensive body should be live, plus two tiny lifecycle callbacks:
// `onHydrated` keeps the provisional height until the blob/error arrives, and
// `onOpenChange` lets a folded offscreen card collapse its placeholder to h-8.
export function ProgressiveFile({
  path,
  version,
  reserve,
  children,
}: {
  path: string;
  version: string;
  // How tall this file will be once it mounts, when the caller can say — the
  // whole reason the pane's height (and so the scrollbar) is arithmetic rather
  // than a guess that moves as bodies land. Omit it and the shell falls back to
  // the flat INITIAL_HEIGHT it always used.
  reserve?: ReserveSpec | null;
  children: (state: {
    active: boolean;
    onHydrated: (ready: boolean) => void;
    onOpenChange: (open: boolean) => void;
  }) => ReactNode;
}) {
  const progressive = useContext(ProgressiveContext);
  const scale = useContext(ReserveContext);
  const enabled = progressive?.enabled ?? false;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef(!enabled);
  const hydratedRef = useRef(false);
  const readyCallbacks = useRef(new Set<OnReady>());
  const [near, setNear] = useState(!enabled);
  const [forced, setForced] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [open, setOpen] = useState(true);
  // Tagged with the font size it was taken at: the layout is rem-scaled, so a
  // font-size change makes every measurement of an offscreen card wrong by that
  // ratio. Dropping it falls back to the (rem-derived) reserve, which is right
  // at any size — the old behaviour was to keep the stale pixels.
  const [measured, setMeasured] = useState<{ height: number; atFont: number } | null>(null);
  const active = !enabled || near || forced;
  activeRef.current = active;

  // Read by the (observer-lifetime) resize callback, which must not re-subscribe
  // every time the learned markdown ratio nudges the reserve.
  const reserveRef = useRef(reserve);
  reserveRef.current = reserve;
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const openRef = useRef(open);
  openRef.current = open;
  // ONE ratio sample per body. The observer reports every height this block ever
  // has — including each frame of a fold animation and every re-measure — and the
  // learner accumulates, so an unguarded sample would let one card be counted
  // dozens of times at heights that aren't its own.
  const sampledRef = useRef(false);

  // A round/ref/theme/snapshot switch invalidates the body behind the same path.
  // Keep the old measured height as a stable provisional size until the new body
  // lands. Reset during RENDER, not from an effect: a body with nothing to fetch
  // (a diff file block — its rows arrived with the payload) reports `onHydrated`
  // from its own layout effect, and a child's effects run BEFORE its parent's, so
  // an effect here would fire after that report and clear it — leaving the block
  // permanently "not hydrated", holding a stale provisional height and never
  // draining a forced jump's callbacks. A render-phase reset lands before any
  // child of the commit runs, and — unlike an effect — doesn't fire on mount,
  // where there is no previous body to invalidate.
  const [lastVersion, setLastVersion] = useState(version);
  if (lastVersion !== version) {
    setLastVersion(version);
    hydratedRef.current = false;
    setHydrated(false);
    sampledRef.current = false;
  }

  const force = useCallback((onReady?: OnReady) => {
    if (onReady) {
      if (hydratedRef.current) requestAnimationFrame(onReady);
      else readyCallbacks.current.add(onReady);
    }
    // Hold until onHydrated (or unmount). A wall-clock expiry would drop
    // `active` on an off-screen fetch, unmount the body, and never drain
    // readyCallbacks — freezing the caller's scroll-spy.
    setForced(true);
  }, []);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || !progressive) return;
    const stop = progressive.observe(el, {
      onNear: setNear,
      onResize: (height) => {
        if (!activeRef.current || height <= 0) return;
        // A settled height for a card that has finished mounting is the only
        // evidence there is about how tall rendered markdown runs — hand it to
        // the provider's learner so the shells further down reserve better. A
        // freshly mounted open card doesn't animate, so its first post-hydration
        // measurement IS the settled one.
        if (
          !sampledRef.current &&
          hydratedRef.current &&
          openRef.current &&
          reserveRef.current &&
          scaleRef.current
        ) {
          sampledRef.current = true;
          scaleRef.current.sample(reserveRef.current, height);
        }
        const atFont = scaleRef.current?.fontSize ?? 0;
        setMeasured((prev) =>
          prev == null || prev.atFont !== atFont || Math.abs(prev.height - height) > 0.5
            ? { height, atFont }
            : prev,
        );
      },
    });
    progressive.registry.current.set(path, force);
    return () => {
      stop();
      if (progressive.registry.current.get(path) === force) {
        progressive.registry.current.delete(path);
      }
    };
  }, [path, progressive, force]);

  useEffect(() => {
    if (!enabled) {
      setNear(true);
      setForced(false);
    }
  }, [enabled]);
  useEffect(() => {
    if (!near || !forced || !hydrated) return;
    setForced(false);
  }, [near, forced, hydrated]);
  // An unmounting shell can never report hydration, so hand its waiters back
  // instead of dropping them — the caller's own retrying jump should decide the
  // outcome, and a dropped callback freezes it forever. A diff round switch does
  // exactly this: the jump activates the outgoing round's block (the path exists
  // in both rounds) one commit before that block unmounts. One frame's delay so
  // the replacement tree is committed before the waiter looks for it.
  useEffect(
    () => () => {
      const callbacks = [...readyCallbacks.current];
      readyCallbacks.current.clear();
      if (callbacks.length > 0)
        requestAnimationFrame(() => callbacks.forEach((callback) => void callback()));
    },
    [],
  );

  // What to stand in for the body: a height already measured at the current font
  // size (exact), else the caller's ReserveSpec (exact for code and folded
  // cards, an estimate for rendered markdown), else the flat fallback. `open`
  // outranks all of it — a card the reader folded is its header and nothing more.
  let bodyHeight: number | string = INITIAL_HEIGHT;
  if (measured && measured.atFont === scale?.fontSize) bodyHeight = measured.height;
  else if (reserve && scale) bodyHeight = reservePx(reserve, scale.fontSize, scale.mdRatio);

  let style: CSSProperties | undefined;
  if (enabled && !active) {
    style = { height: open ? bodyHeight : FOLDED_HEIGHT };
  } else if (enabled && !hydrated) {
    style = { minHeight: open ? bodyHeight : FOLDED_HEIGHT };
  }

  const onHydrated = useCallback((ready: boolean) => {
    hydratedRef.current = ready;
    setHydrated(ready);
    if (!ready || readyCallbacks.current.size === 0) return;
    const callbacks = [...readyCallbacks.current];
    readyCallbacks.current.clear();
    // FileView reports from a passive effect. One frame lets any sibling
    // viewed/fold state commit before a picker jump re-aligns the final block.
    requestAnimationFrame(() => callbacks.forEach((callback) => void callback()));
  }, []);
  const onOpenChange = useCallback((next: boolean) => setOpen(next), []);

  return (
    <div
      ref={rootRef}
      data-file={path}
      data-progressive-file={active ? "active" : "inactive"}
      style={style}
    >
      {children({ active, onHydrated, onOpenChange })}
    </div>
  );
}
