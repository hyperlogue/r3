import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Collapse, CommentPlusIcon, cn, FoldTriangle, scrollParent } from "../ui.tsx";
import { FilePath } from "./FilePath.tsx";

// Inline SVGs (not unicode glyphs) so the icons sit on the text's optical
// centre — ▸/▾/✓/○ render with inconsistent vertical metrics across fonts,
// which is why the fold triangle looked misaligned.

function CheckIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" className={className}>
      <path
        d="M13.5 4.5 L6.5 11.5 L3 8"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

// A fold/unfold broadcast from the pane toolbar: every FileCard that sees a
// new nonce applies `mode`. A monotonic nonce (not a bare mode) so clicking
// "fold all" twice re-folds files the user re-opened in between. With `path`
// set the signal is scoped to that one file — how next/prev navigation unfolds
// the block it's about to land on.
//
// `"toggle"` flips whatever the receiving card currently is, rather than driving
// it to a known state — the keyboard `z` on the current file, which has to behave
// like clicking that file's own triangle. It's only ever sent path-scoped: an
// unscoped toggle would flip each card independently and shatter the fold state.
export interface FoldSignal {
  mode: "fold" | "unfold" | "toggle";
  nonce: number;
  path?: string;
}

// A file block with a sticky header (filename stays pinned to the top of the
// scroll area while you read the file), a fold triangle, a per-file stats
// slot, and a "viewed" toggle. Marking a file viewed folds it; long files start
// folded (autoFold). Full-bleed — no card chrome (border/rounding/margin) — so
// a file reads like the foldable summary bar above the pane. The header is
// sticky, so nothing around it may clip vertical overflow (the animated
// Collapse only wraps the content below it).
export function FileCard({
  path,
  pathAction,
  stats,
  wrapHeader = false,
  viewed,
  onToggleViewed,
  onFileThread,
  autoFold = false,
  current = false,
  foldSignal,
  unscopedFold = null,
  ownsFileMarker = true,
  onOpenChange,
  children,
}: {
  path: string;
  // A file-scoped action beside the path, available even while folded.
  pathAction?: ReactNode;
  // A render fn receives the open state, so header controls (e.g. a markdown
  // rendered/raw toggle) can hide themselves when the card is folded.
  stats?: ReactNode | ((open: boolean) => ReactNode);
  // Media tools can flow onto another header row in a narrow pane.
  wrapHeader?: boolean;
  viewed: boolean;
  // Omit when this surface does not offer read-progress controls.
  onToggleViewed?: () => void;
  // Open the comment composer anchored to this whole file (no line span). Absent
  // ⇒ no button (a view where whole-file threads don't apply).
  onFileThread?: () => void;
  autoFold?: boolean;
  // This is the file the scroll-spy calls current — the one a per-file keyboard
  // shortcut (`z` fold, `x` viewed, `a` note) would act on. The per-file bindings
  // MUTATE, so the target can't be implicit: before this the only hint was a
  // subtle tint in the desktop-only file browser, which is no help at all on a
  // phone or with the sidebar closed. Marking the header puts it where the eye
  // already is — the header of the current file is the one pinned to the pane top.
  current?: boolean;
  foldSignal?: FoldSignal | null;
  // Last toolbar fold-all / unfold-all. A deferred FileCard never saw that
  // nonce, so it takes this as its initial open rather than replaying the stale
  // unscoped signal (which would clobber autoFold/viewed).
  unscopedFold?: "fold" | "unfold" | null;
  // ProgressiveFile owns the stable outer [data-file] block in large reviews;
  // direct FileCard/ArtifactFile renders own the marker here.
  ownsFileMarker?: boolean;
  // Review-level progressive rendering preserves a folded block's offscreen
  // placeholder height without lifting control of the fold itself.
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => {
    if (unscopedFold === "fold") return false;
    if (unscopedFold === "unfold") return true;
    return !(viewed || autoFold);
  });
  const rootRef = useRef<HTMLDivElement>(null);

  // Fold this file, re-pinning the scroll pane first. Folding a file you've
  // scrolled down into would otherwise leave the pane at the same scrollTop,
  // now pointing into some *later* file — a disorienting jump. When this file's
  // top is scrolled above the pane, glide its (sticky) header up to the pane top
  // as the content collapses, so the next file rises into view instead.
  const foldToTop = useCallback(() => {
    const card = rootRef.current;
    const pane = scrollParent(card);
    if (card && pane) {
      const delta = card.getBoundingClientRect().top - pane.getBoundingClientRect().top;
      if (delta < -1) pane.scrollBy({ top: delta, behavior: "smooth" });
    }
    setOpen(false);
  }, []);

  // Fold when marked viewed, unfold when unmarked — but don't let this run on
  // mount clobber the autoFold-driven initial state.
  const mounted = useRef(false);
  // A progressively loaded card reports its sha just after mounting, so its
  // stored viewed flag can arrive one commit after a targeted jump or unfold-all
  // opened it. Preserve that only through this mount beat; a later user "Viewed"
  // toggle must retain the normal fold behavior.
  const preserveTargetedUnfold = useRef(
    (foldSignal?.path === path && foldSignal.mode === "unfold") || unscopedFold === "unfold",
  );
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      preserveTargetedUnfold.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (viewed) {
      if (preserveTargetedUnfold.current) {
        preserveTargetedUnfold.current = false;
        setOpen(true);
      } else foldToTop();
    } else setOpen(true);
  }, [viewed, foldToTop]);

  // Apply the toolbar's fold/unfold signal. A path-scoped jump may target a
  // progressively deferred file before this card exists, so replay that targeted
  // signal on mount. Ignore an old unscoped fold-all, which may predate the card
  // and would otherwise clobber its autoFold/viewed initial state.
  const seenNonce = useRef(foldSignal?.path === path ? undefined : foldSignal?.nonce);
  useEffect(() => {
    if (
      foldSignal &&
      foldSignal.nonce !== seenNonce.current &&
      (foldSignal.path == null || foldSignal.path === path)
    ) {
      seenNonce.current = foldSignal.nonce;
      // A "toggle" is one deliberate act on one card, so it folds through
      // foldToTop exactly as the header triangle does (re-pinning the pane so the
      // collapse doesn't drop you into a later file). A fold-ALL deliberately does
      // NOT: it would fire a smooth scrollBy per card, all fighting each other.
      if (foldSignal.mode === "toggle") {
        if (open) foldToTop();
        else setOpen(true);
      } else setOpen(foldSignal.mode === "unfold");
    }
  }, [foldSignal, path, open, foldToTop]);

  useEffect(() => onOpenChange?.(open), [open, onOpenChange]);

  return (
    <div ref={rootRef} data-file={ownsFileMarker ? path : undefined}>
      {/* The -1px (not 0): the rem-scaled layout (root font-size setting) puts
          row heights on fractional pixels, and an exact pin can round a hair below
          the scrollport edge — a sub-pixel slit of the scrolled code peeks over
          the header. Overshooting by 1px clips a pixel of the header's own
          background instead, which is invisible. (Costs a barely-perceptible 1px
          settle as it pins — the lesser evil vs. the slit.)
          --pane-sticky-h is the workspace toolbar's measured height (ArtifactView sets
          it on the scroll pane). Without a toolbar it defaults to 0px, the plain
          -top-px pin. */}
      {/* The current-file marker is a 2px accent rail on the header's leading edge
          and NOTHING else — no fill, no badge, no label. A header tint was tried
          and read as too loud: one of these is on screen at all times, so the
          marker has to be ignorable while you read and only findable when you go
          looking for "which file does `x` hit?". The rail is a `before`
          pseudo-element so it costs no layout box and can't shift the fold
          triangle that sits at the same edge; `sticky` already positions the
          header, so it needs no `relative` to anchor to (adding one would fight
          the sticky pin — both set `position`). */}
      <div
        data-file-header
        className={cn(
          "sticky top-[calc(var(--pane-sticky-h,0px)-1px)] z-10 flex h-8 items-center gap-2 max-md:gap-1 border-b border-neutral-300 bg-neutral-50/95 px-2 backdrop-blur dark:border-neutral-700 dark:bg-neutral-900/95",
          wrapHeader && open && "h-auto min-h-8 flex-wrap gap-y-0",
          current &&
            "before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary-500 dark:before:bg-primary-400",
        )}
      >
        {/* Enlarge the click target, not the glyph: `self-stretch` fills the
            header's full height and the wider `px-2` (with a `-ml-1` that reclaims
            the header's own left padding) widens it — the triangle stays put and
            unchanged in size. */}
        <button
          type="button"
          onClick={() => (open ? foldToTop() : setOpen(true))}
          className="-ml-1 flex shrink-0 items-center self-stretch px-2 text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200"
          title={open ? "Collapse" : "Expand"}
        >
          <FoldTriangle open={open} />
        </button>
        {wrapHeader && open ? (
          <div className="flex min-h-8 min-w-24 flex-1 items-center">
            <FilePath key={path} path={path} action={pathAction} />
          </div>
        ) : (
          <FilePath key={path} path={path} action={pathAction} />
        )}
        <div
          className={cn("flex items-center gap-2 max-md:gap-1", wrapHeader && "ml-auto max-w-full")}
        >
          {wrapHeader && open ? (
            <div className="flex min-w-0 items-center">
              {typeof stats === "function" ? stats(open) : stats}
            </div>
          ) : typeof stats === "function" ? (
            stats(open)
          ) : (
            stats
          )}
          {onToggleViewed && (
            <button
              type="button"
              onClick={onToggleViewed}
              aria-pressed={viewed}
              title={viewed ? "Marked viewed — click to unmark" : "Mark file viewed"}
              className={cn(
                "flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-[0.625rem] leading-3.5 font-medium transition-colors pointer-coarse:self-stretch pointer-coarse:min-w-7",
                viewed
                  ? "bg-success-100 text-success-700 dark:bg-success-900/50 dark:text-success-300"
                  : "text-neutral-600 hover:bg-neutral-200 hover:text-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-100",
              )}
            >
              {/* A square checkbox that stays visible once viewed, so it still reads
                as a toggle you can click again to unmark. */}
              <span
                className={cn(
                  "flex size-3 items-center justify-center rounded-[3px] border transition-colors",
                  viewed
                    ? "border-success-600 bg-success-600 text-white dark:border-success-500 dark:bg-success-500 dark:text-success-950"
                    : "border-neutral-400 dark:border-neutral-500",
                )}
              >
                {viewed && <CheckIcon className="size-2.5" />}
              </span>
              <span className="max-md:sr-only">Viewed</span>
            </button>
          )}
          {onFileThread && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onFileThread();
              }}
              title="Leave a comment on this file"
              // Match the sibling "Viewed" pill's height (same py-0.5; the size-3.5
              // icon ≈ the pill's text/checkbox line-box) so the two per-file
              // controls read as one matched cluster — the same reason the markdown
              // rendered/raw toggle sizes itself to the pill.
              // `-ml-1.5` evens the visible spacing: the preceding "Viewed" pill
              // donates its px-1.5 right padding to the gap, while the pill before
              // *it* sits flush (border at its box edge, no padding donated). Pulling
              // the icon left by that same px-1.5 makes both inter-control gaps equal.
              // pointer-coarse:py-2/pr-2 grow the touch target vertically (absorbed by
              // the h-8 header's items-center — no height change) and rightward into
              // the header's own px-2 padding, never leftward toward the Viewed pill.
              className="-ml-1.5 flex shrink-0 items-center rounded px-1 py-0.5 text-neutral-400 transition-colors hover:bg-neutral-200 hover:text-neutral-700 pointer-coarse:py-2 pointer-coarse:pr-2 dark:hover:bg-neutral-800 dark:hover:text-neutral-200"
            >
              <CommentPlusIcon className="size-3.5" />
            </button>
          )}
        </div>
      </div>
      {/* The block's bottom separator lives on the content, inside the fold, so
          it slides away with it — the (always-bordered) header then provides the
          separator while folded, never doubling up. */}
      <Collapse open={open}>
        <div className="border-b border-neutral-300 bg-white dark:border-neutral-700 dark:bg-neutral-950">
          {children}
        </div>
      </Collapse>
    </div>
  );
}
