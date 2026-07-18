import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { copyText } from "../clipboard.ts";
import { Collapse, CommentPlusIcon, cn, FoldTriangle, scrollParent, useCopyFlash } from "../ui.tsx";

function splitPath(path: string): { dir: string; name: string } {
  const i = path.lastIndexOf("/");
  return i === -1
    ? { dir: "", name: path }
    : { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}

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

// Classic two-card copy glyph.
function CopyIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden="true"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
    >
      <rect x="6" y="6" width="8" height="8" rx="1.5" />
      <path d="M10 6 V4 A1.5 1.5 0 0 0 8.5 2.5 H4 A1.5 1.5 0 0 0 2.5 4 V8.5 A1.5 1.5 0 0 0 4 10 H6" />
    </svg>
  );
}

// A fold/unfold broadcast from the pane toolbar: every FileCard that sees a
// new nonce applies `mode`. A monotonic nonce (not a bare mode) so clicking
// "fold all" twice re-folds files the user re-opened in between. With `path`
// set the signal is scoped to that one file — how next/prev navigation unfolds
// the block it's about to land on.
export interface FoldSignal {
  mode: "fold" | "unfold";
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
  stats,
  viewed,
  onToggleViewed,
  onFileFeedback,
  autoFold = false,
  foldSignal,
  children,
}: {
  path: string;
  // A render fn receives the open state, so header controls (e.g. a markdown
  // rendered/raw toggle) can hide themselves when the card is folded.
  stats?: ReactNode | ((open: boolean) => ReactNode);
  viewed: boolean;
  // Absent ⇒ viewed isn't tracked in this view (e.g. a files review's snapshot-diff
  // or a pinned-snapshot browse); the toggle is hidden entirely.
  onToggleViewed?: () => void;
  // Open the feedback composer anchored to this whole file (no line span). Absent
  // ⇒ no button (a view where whole-file feedback doesn't apply).
  onFileFeedback?: () => void;
  autoFold?: boolean;
  foldSignal?: FoldSignal | null;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => !(viewed || autoFold));
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
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    if (viewed) foldToTop();
    else setOpen(true);
  }, [viewed, foldToTop]);

  // Apply the toolbar's fold/unfold signal (all files, or just this path when
  // scoped). Seed the ref with the mount-time nonce so a card mounting late
  // (async blob load) doesn't replay a signal that was fired before it existed
  // over its autoFold/viewed initial state.
  const seenNonce = useRef(foldSignal?.nonce);
  useEffect(() => {
    if (
      foldSignal &&
      foldSignal.nonce !== seenNonce.current &&
      (foldSignal.path == null || foldSignal.path === path)
    ) {
      seenNonce.current = foldSignal.nonce;
      setOpen(foldSignal.mode === "unfold");
    }
  }, [foldSignal, path]);

  // Click the path to copy it (mirrors console's CopyableId); the chevron still
  // toggles the fold.
  const { copied, flash } = useCopyFlash();
  const copyPath = () => {
    // Route through copyText (not navigator.clipboard directly) for its
    // execCommand fallback: on a plain-http/remote bind navigator.clipboard is
    // undefined, and a bare `?.` short-circuit would silently do nothing.
    void copyText(path).then((ok) => {
      if (ok) flash();
    });
  };

  const { dir, name } = splitPath(path);

  return (
    <div ref={rootRef} data-file={path}>
      {/* -top-px, not top-0: the rem-scaled layout (root font-size setting) puts
          row heights on fractional pixels, and a top-0 pin can round a hair below
          the scrollport edge — a sub-pixel slit of the scrolled code peeks over
          the header. Overshooting by 1px clips a pixel of the header's own
          background instead, which is invisible. (Costs a barely-perceptible 1px
          settle as it pins — the lesser evil vs. the slit.) */}
      <div className="sticky -top-px z-10 flex h-8 items-center gap-2 border-b border-neutral-300 bg-neutral-50/95 px-2 backdrop-blur dark:border-neutral-700 dark:bg-neutral-900/95">
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
        <button
          type="button"
          onClick={copyPath}
          className="group/path inline-flex min-w-0 flex-1 items-center gap-1.5 text-left font-mono text-xs"
          title={copied ? "Copied!" : `Copy path: ${path}`}
        >
          <span className="min-w-0 truncate">
            <span className="text-neutral-400">{dir}</span>
            <span className="font-medium text-neutral-800 dark:text-neutral-100">{name}</span>
          </span>
          {copied ? (
            <CheckIcon className="size-3 shrink-0 text-success-600 dark:text-success-400" />
          ) : (
            <CopyIcon className="size-3 shrink-0 text-neutral-400 opacity-0 transition-opacity group-hover/path:opacity-100 pointer-coarse:opacity-100" />
          )}
        </button>
        {typeof stats === "function" ? stats(open) : stats}
        {onToggleViewed && (
          <button
            type="button"
            onClick={onToggleViewed}
            title={viewed ? "Marked viewed — click to unmark" : "Mark file viewed"}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded px-1.5 py-0.5 text-[0.625rem] font-medium transition-colors",
              viewed
                ? "bg-success-100 text-success-700 dark:bg-success-900/50 dark:text-success-300"
                : "text-neutral-400 hover:bg-neutral-200 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200",
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
            Viewed
          </button>
        )}
        {onFileFeedback && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onFileFeedback();
            }}
            title="Leave feedback on this file"
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
