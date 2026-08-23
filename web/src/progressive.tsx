// Review-level progressive rendering for large plain-file reviews.
//
// Row virtualization (virtual.tsx) bounds the rows mounted *inside one file*, but
// a large review can still mount dozens of per-file virtualizers against the same
// scroll pane and eagerly fetch every blob. This layer bounds the other axis: one
// shared IntersectionObserver activates only file bodies near the pane, while an
// inactive file keeps its measured block height so the one continuous scroll
// surface, sticky headers, scroll-spy, and file jumps keep their geometry.

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

// Small reviews are cheaper and simpler rendered eagerly. Past this point the
// number of concurrent blob requests / per-file virtualizers becomes the larger
// cost, so progressively hydrate file bodies instead.
export const PROGRESSIVE_FILES_MIN = 24;

// An unseen file needs enough provisional height that the initially compact set
// of shells does not all enter the preload band before the first blobs land. The
// estimate is replaced by the exact measured height after first render.
const INITIAL_HEIGHT = "16rem";
const FOLDED_HEIGHT = "2rem"; // FileCard's protected h-8 header.
const PRELOAD_MARGIN_PX = 1000;

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
  return <ProgressiveContext.Provider value={value}>{children}</ProgressiveContext.Provider>;
}

// One stable file block in the review stack. Its render prop receives whether
// the expensive body should be live, plus two tiny lifecycle callbacks:
// `onHydrated` keeps the provisional height until the blob/error arrives, and
// `onOpenChange` lets a folded offscreen card collapse its placeholder to h-8.
export function ProgressiveFile({
  path,
  version,
  children,
}: {
  path: string;
  version: string;
  children: (state: {
    active: boolean;
    onHydrated: (ready: boolean) => void;
    onOpenChange: (open: boolean) => void;
  }) => ReactNode;
}) {
  const progressive = useContext(ProgressiveContext);
  const enabled = progressive?.enabled ?? false;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const activeRef = useRef(!enabled);
  const hydratedRef = useRef(false);
  const readyCallbacks = useRef(new Set<OnReady>());
  const [near, setNear] = useState(!enabled);
  const [forced, setForced] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [open, setOpen] = useState(true);
  const [measuredHeight, setMeasuredHeight] = useState<number | null>(null);
  const active = !enabled || near || forced;
  activeRef.current = active;

  // A ref/theme/snapshot switch invalidates the body behind the same path. Keep
  // the old measured height as a stable provisional size until the new body lands.
  // biome-ignore lint/correctness/useExhaustiveDependencies: version is the reset signal; the effect deliberately does not read its value
  useLayoutEffect(() => {
    hydratedRef.current = false;
    setHydrated(false);
  }, [version]);

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
        setMeasuredHeight((prev) =>
          prev == null || Math.abs(prev - height) > 0.5 ? height : prev,
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
  useEffect(
    () => () => {
      readyCallbacks.current.clear();
    },
    [],
  );

  let style: CSSProperties | undefined;
  if (enabled && !active) {
    style = { height: open ? (measuredHeight ?? INITIAL_HEIGHT) : FOLDED_HEIGHT };
  } else if (enabled && !hydrated) {
    style = { minHeight: open ? (measuredHeight ?? INITIAL_HEIGHT) : FOLDED_HEIGHT };
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
