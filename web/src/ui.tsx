import type {
  ButtonHTMLAttributes,
  ReactNode,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

// The nearest scrollable ancestor of `el` — the pane it scrolls within. Walks the
// DOM (rather than threading a ref down) so a shared leaf component can find its
// own scroll container. Returns null if there is none (e.g. in Storybook).
export function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let n = el?.parentElement ?? null; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if (oy === "auto" || oy === "scroll") return n;
  }
  return null;
}

// A pane width the user can drag, persisted in localStorage under `key`. Returns
// the current width, a `dragging` flag (to suppress width transitions mid-drag),
// an `onPointerDown` for a resize handle on the pane's edge, and an
// `onDoubleClick` that resets to the default. The drag tracks via window pointer
// listeners (so it keeps working past the handle), clamps to [min,max], and
// writes the final width on release. `grow: "left"` (default) fits a right-docked
// pane (drag left = wider); `grow: "right"` fits a left-docked pane.
//
// Two ways to set the default: a fixed `initial` px (fixed-width panels like the
// reviews sidebar — seeds the width from the first render), or a `defaultFraction`
// of `containerRef`'s width (a proportional split, e.g. 0.382 for a golden
// feedback split — adapts to the viewport). A fraction is measured once the
// container is laid out, so until then (or a saved width) the width is `undefined`
// and the pane sizes to content for the pre-paint frame only.
export function useResizableWidth(
  key: string,
  opts: {
    min: number;
    max: number;
    grow?: "left" | "right";
    initial?: number;
    defaultFraction?: number;
    containerRef?: RefObject<HTMLElement | null>;
  },
): {
  width: number | undefined;
  dragging: boolean;
  onPointerDown: (e: ReactPointerEvent) => void;
  onDoubleClick: () => void;
} {
  const { min, max, grow = "left", initial, defaultFraction, containerRef } = opts;
  const clamp = useCallback((w: number) => Math.min(max, Math.max(min, w)), [min, max]);
  // The default width: a fraction of the container once it's measurable, else the
  // fixed `initial`. `undefined` only while a requested fraction is unmeasured.
  const computeDefault = useCallback(() => {
    if (defaultFraction != null && containerRef) {
      const w = containerRef.current?.clientWidth;
      return w ? clamp(w * defaultFraction) : undefined;
    }
    return initial != null ? clamp(initial) : undefined;
  }, [containerRef, clamp, defaultFraction, initial]);

  const [width, setWidth] = useState<number | undefined>(() => {
    const saved = Number(localStorage.getItem(key));
    if (Number.isFinite(saved) && saved > 0) return clamp(saved);
    // A fixed default seeds immediately; a fractional one waits for measurement.
    return initial != null ? clamp(initial) : undefined;
  });
  const ref = useRef(width);
  ref.current = width;
  const [dragging, setDragging] = useState(false);
  // The teardown for an in-flight drag (window listeners + body-style overrides),
  // set while dragging so a mid-drag unmount can run it; null when not dragging.
  const cleanupRef = useRef<(() => void) | null>(null);

  // No width yet → fall back to the default once it's computable. Runs after
  // *every* commit (no deps): a container measured for a fraction can mount later
  // than this hook's first run — e.g. gated behind a "Loading…" branch, so the
  // first measure sees a null ref — and a one-shot effect would never re-measure,
  // leaving width `undefined`. The pane then sizes to its content and crowds its
  // neighbor out (the "panel 100% / file 0%" bug). The guard makes this a no-op
  // the moment a width exists, so the per-render cost is a single ref read.
  useLayoutEffect(() => {
    if (ref.current !== undefined) return;
    const d = computeDefault();
    if (d !== undefined) setWidth(d);
  });

  const onPointerDown = useCallback(
    (e: ReactPointerEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = ref.current ?? computeDefault() ?? min;
      const dir = grow === "left" ? -1 : 1;
      setDragging(true);
      const onMove = (ev: PointerEvent) => setWidth(clamp(startW + dir * (ev.clientX - startX)));
      const onUp = () => {
        cleanupRef.current?.();
        setDragging(false);
        if (ref.current !== undefined) localStorage.setItem(key, String(ref.current));
      };
      // Everything the drag installs, torn down in one place — run by pointerup on
      // a normal release and by the unmount effect below if the component goes away
      // mid-drag (so the window listeners + body-style overrides never leak).
      cleanupRef.current = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        cleanupRef.current = null;
      };
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [key, clamp, grow, computeDefault, min],
  );

  // Unmounting mid-drag (e.g. the review is deleted and we navigate away) never
  // fires pointerup — tear down any in-flight drag on unmount so it doesn't leak.
  useEffect(() => () => cleanupRef.current?.(), []);

  // Double-click the handle → forget the saved width and snap back to the default.
  const onDoubleClick = useCallback(() => {
    localStorage.removeItem(key);
    const d = computeDefault();
    if (d !== undefined) setWidth(d);
  }, [key, computeDefault]);

  return { width, dragging, onPointerDown, onDoubleClick };
}

// Shared "flash a Copied! confirmation" state for copy-to-clipboard buttons.
// `flash()` shows the confirmation and auto-resets after `ms`; the timer is
// coalesced across rapid clicks and cleared on unmount, so it never fires
// setState on an unmounted component.
export function useCopyFlash(ms = 1500): { copied: boolean; flash: () => void } {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const flash = () => {
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), ms);
  };
  return { copied, flash };
}

// --- Fold affordances -------------------------------------------------------
// One icon language for every fold in the app. A *horizontal* fold (a section
// collapsing upward: summary, file block, directory subtree, earlier replies)
// is a filled triangle that points right when folded and rotates to point down
// when open. A *vertical* fold (a panel collapsing into a rail: reviews
// sidebar, file browser) is a double chevron pointing where the panel will
// slide. Inline SVGs, not unicode glyphs, so the icons sit on the text's
// optical centre across fonts.

export function FoldTriangle({
  open,
  className = "size-2.5",
}: {
  open: boolean;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 8 8"
      aria-hidden="true"
      className={cn(
        "shrink-0 fill-current transition-transform duration-200",
        open && "rotate-90",
        className,
      )}
    >
      <path d="M1.5 0.5 L7 4 L1.5 7.5 Z" />
    </svg>
  );
}

export function FoldChevrons({
  dir,
  className = "size-4",
}: {
  dir: "left" | "right";
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("shrink-0", dir === "left" && "rotate-180", className)}
    >
      <path d="m6 17 5-5-5-5" />
      <path d="m13 17 5-5-5-5" />
    </svg>
  );
}

// Discard/delete affordance — a trash can (Lucide "trash-2"). Used icon-only for a
// destructive action that would read as too loud spelled out as a bordered button
// (e.g. "Discard" beside a filled Save), so it stays a quiet neutral glyph that
// only picks up the danger hue on hover.
export function TrashIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("shrink-0", className)}
    >
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
    </svg>
  );
}

// A speech bubble with a plus inside — the shared "leave a note" mark. Used for
// both the file header's whole-file feedback button and the panel's "add general
// feedback" button, so the two read as the same gesture at different scopes.
export function CommentPlusIcon({ className = "size-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("shrink-0", className)}
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      <path d="M12 7v6" />
      <path d="M9 10h6" />
    </svg>
  );
}

// Animated horizontal fold: sweeps the content's height via the grid-rows trick
// (0fr ⇄ 1fr), so fold/unfold slides smoothly instead of popping — grid tracks
// can animate to the content's intrinsic height, which `height: auto` can't.
// Children mount on first open (a review full of auto-folded thousand-line
// files never pays for hidden rows) and stay mounted after, so the close
// animation has content to slide away; `inert` keeps folded content out of tab
// order and hit testing.
export function Collapse({
  open,
  children,
  className,
}: {
  open: boolean;
  children: ReactNode;
  className?: string;
}) {
  const [everOpened, setEverOpened] = useState(open);
  if (open && !everOpened) setEverOpened(true);
  return (
    <div
      className={cn(
        "grid transition-[grid-template-rows] duration-200 ease-in-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        className,
      )}
    >
      <div inert={!open} className="min-h-0 overflow-hidden">
        {everOpened ? children : null}
      </div>
    </div>
  );
}

export function Button({
  variant = "default",
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "ghost" | "danger" | "success";
}) {
  // max-md:min-h-9 gives every shared button a compact ~40px touch target below
  // md (inert on desktop) — real-device feedback found full 44px CTAs
  // (Approve/Submit) too tall for the phone layout. The shared Button is only
  // used off the protected h-8 header stack (the feedback action rows,
  // composers, panel/review-header CTAs, login, settings) — those bars use
  // their own raw buttons — so this can't grow any h-8 bar.
  const base =
    "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none cursor-pointer max-md:min-h-9";
  const variants = {
    default:
      "bg-neutral-100 hover:bg-neutral-200 text-neutral-800 dark:bg-neutral-800 dark:hover:bg-neutral-700 dark:text-neutral-100",
    primary: "bg-primary-600 hover:bg-primary-500 text-white",
    ghost: "hover:bg-neutral-100 dark:hover:bg-neutral-800 text-neutral-600 dark:text-neutral-300",
    danger: "bg-danger-600/90 hover:bg-danger-600 text-white",
    // Approval — the terminal "this review is good" action. Success green (the
    // resolution hue) is reserved for it; the live hand-off to a watching agent
    // (Submit) uses primary-indigo instead, so the two green-vs-indigo reads stay
    // distinct.
    success: "bg-success-600 hover:bg-success-500 text-white",
  };
  return <button className={cn(base, variants[variant], className)} {...props} />;
}

export function Pill({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[0.625rem] font-medium text-neutral-600 dark:text-neutral-300",
        className,
      )}
    >
      {children}
    </span>
  );
}
