import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ApiError, api } from "../api.ts";
import { copyText } from "../clipboard.ts";
import { DiffView, RoundSelect } from "../components/DiffView.tsx";
import { FeedbackPanel } from "../components/FeedbackPanel.tsx";
import { FileBrowser } from "../components/FileBrowser.tsx";
import type { FoldSignal } from "../components/FileCard.tsx";
import { FileView } from "../components/FileView.tsx";
import { QuoteBubble, type QuotePos, quoteBlock } from "../components/Message.tsx";
import { ReviewSummary } from "../components/ReviewSummary.tsx";
import { SnapshotSelect } from "../components/SnapshotSelect.tsx";
import {
  clearDraft,
  dropAnchor,
  getDraft,
  setDraftAnchor,
  setDraftText,
  useDraftAnchor,
} from "../drafts.ts";
import { shortSha, sourceLabel } from "../format.ts";
import type { MessageRef } from "../markdown.ts";
import {
  HL_ACTIVE,
  HL_FEEDBACK,
  rangeForQuote,
  setHighlightRanges,
  supportsHighlights,
} from "../mdhighlight.ts";
import { type Placement, placeInDiff } from "../resolveFeedback.ts";
import { navigate } from "../router.ts";
import { getSelectionAnchor, type PendingAnchor } from "../selection.ts";
import { useSyntaxTheme } from "../settings.ts";
import type {
  DiffSide,
  FeedbackWithReplies,
  PatchDiff,
  ReviewStatus,
  SnapshotRef,
  UpdateReviewBody,
} from "../types.ts";
import { SUMMARY_FILE } from "../types.ts";
import { Button, cn, useResizableWidth } from "../ui.tsx";
import { diffViewedKey, fileViewedKey, useViewedFiles } from "../viewed.ts";
import {
  fileScrollKey,
  type ScrollToLine,
  useVirtualPaneController,
  VirtualPaneProvider,
} from "../virtual.tsx";

// Where the focused line sits after a scroll: 30% down the viewport, so there's
// reading context above it.
const SCROLL_RATIO = 0.3;

// FileCard's sticky header (h-8 = 32px) overlays the top of the scroll pane, so
// a row in that band sits inside the pane's box but is visually covered — the
// anchor-in-view test treats it as off screen.
const STICKY_HEADER_PX = 32;

// A files review's derived snapshot-diff is rendered through DiffView as a single
// synthetic round; this is its [data-round] seq. Feedback in a files review keeps
// patch_seq null (it isn't scoped to a round), so this only scopes the DOM query
// for active-line highlighting — it never reaches the server.
const SNAPSHOT_DIFF_SEQ = 0;

// Imperatively ring the lines an active feedback points at (its DOM rows live
// inside dangerouslySetInnerHTML content, so we toggle a class directly) and,
// only on a human navigation, scroll them to ~30% of the pane. Two concerns,
// split: the effect re-runs and re-marks the rows on any anchor-primitive change
// (so a live re-anchor keeps the ring on the right line), but it issues a scroll
// ONLY when `fbId` or `scrollNonce` differs from the previous run — the human
// clicked a feedback, or re-clicked locate. A background anchor shift (server
// re-anchor → new line_start, or a diff-placement move) re-rings in place without
// yanking the pane. Even a navigation skips the scroll when the anchored rows are
// already fully on screen — saving a note on the selection under your eyes (or
// locating a visible line) rings in place instead of re-seating the pane.
function useActiveLineHighlight(
  scope: React.RefObject<HTMLElement | null>,
  fb: FeedbackWithReplies | null,
  scrollNonce: number,
  scrollToLine: ScrollToLine,
) {
  const fbId = fb?.id ?? null;
  const file = fb?.file ?? null;
  const side = fb?.side ?? null;
  const lineStart = fb?.line_start ?? null;
  const lineEnd = fb?.line_end ?? null;
  const patchSeq = fb?.patch_seq ?? null;
  const quote = fb?.quote ?? null;
  // The fbId/scrollNonce of the previous run, so a run can tell a human navigation
  // (scroll) from an anchor merely shifting under a stable selection (mark only).
  const prevScroll = useRef<{ fbId: string | null; nonce: number }>({ fbId: null, nonce: -1 });
  // scrollNonce is both read (to decide shouldScroll below) and a dep, so an
  // explicit locate click re-runs this and re-scrolls even when the anchor hasn't
  // changed.
  useEffect(() => {
    const root = scope.current;
    if (!root) return;
    for (const el of root.querySelectorAll(".r3-active-line"))
      el.classList.remove("r3-active-line");
    setHighlightRanges(HL_ACTIVE, []);
    // Summary notes (prose, not file rows) are owned by useActiveSummaryHighlight,
    // which also drives HL_ACTIVE for the located quote — bail before this hook
    // would fight it over the same registry (or spin its retry loop on a
    // non-existent `@summary` file).
    if (file === SUMMARY_FILE) return;
    // Scroll only on a human navigation — a new feedback or a re-clicked locate; a
    // background anchor shift (same fbId + nonce) re-marks the rows in place.
    const shouldScroll =
      fbId !== prevScroll.current.fbId || scrollNonce !== prevScroll.current.nonce;
    prevScroll.current = { fbId, nonce: scrollNonce };
    // A whole-file note has a real path but no line span: bring the file's header
    // into view without marking a row. Retry across a few frames so a folded file
    // that locateFeedback just unfolded has time to mount.
    if (fbId != null && file != null && file !== SUMMARY_FILE && lineStart == null) {
      if (!shouldScroll) return;
      const scopeSel = patchSeq != null ? `[data-round="${patchSeq}"] ` : "";
      let tries = 0;
      let raf = requestAnimationFrame(function toFile() {
        const el = root.querySelector(`${scopeSel}[data-file="${CSS.escape(file)}"]`);
        if (el) {
          const p = root.getBoundingClientRect();
          const r = el.getBoundingClientRect();
          // The note covers the whole file — any part of it already on screen
          // means the target is in view; don't yank the pane to its header.
          if (r.bottom > p.top && r.top < p.bottom) return;
          root.scrollTo({ top: root.scrollTop + r.top - p.top - 8, behavior: "smooth" });
          return;
        }
        if (++tries > 60) return;
        raf = requestAnimationFrame(toFile);
      });
      return () => cancelAnimationFrame(raf);
    }
    if (fbId == null || file == null || lineStart == null) return;
    // Rounds can repeat a path with unrelated line numbers, so an anchor that
    // names a round resolves inside that round's scope only; a null patch_seq
    // (files review / legacy) falls back to the first match = the first round.
    const scopeSel = patchSeq != null ? `[data-round="${patchSeq}"] ` : "";
    const scrollKey = fileScrollKey(patchSeq, file);
    // A navigation to an anchor that's already fully on screen (minus the
    // sticky-header band) skips the scroll — the ring alone marks it. Rows
    // resolve only when mounted, so a virtualized-away or folded target reports
    // not-visible and scrolls as before.
    const anchorInView = (): boolean => {
      const fileEl = root.querySelector(`${scopeSel}[data-file="${CSS.escape(file)}"]`);
      if (!fileEl) return false;
      const row = (n: number) =>
        side
          ? fileEl.querySelector(`[data-line="${n}"][data-side="${side}"]`)
          : fileEl.querySelector(`[data-line="${n}"]`);
      let head: Element | Range | null = row(lineStart);
      let tail: Element | Range | null =
        lineEnd == null || lineEnd === lineStart ? head : row(lineEnd);
      // Rendered markdown has no per-line rows — measure the quoted text when
      // findable (the enclosing block is far wider than the anchor), else the
      // containing block, mirroring mark()'s resolution below.
      if (!head || !tail) {
        const end = lineEnd ?? lineStart;
        let block: Element | null = null;
        for (const el of fileEl.querySelectorAll("[data-line-start]")) {
          const bs = Number(el.getAttribute("data-line-start"));
          const be = Number(el.getAttribute("data-line-end") ?? bs);
          if (bs <= end && be >= lineStart) {
            block = el;
            break;
          }
        }
        if (!block) return false;
        head = tail = (quote ? rangeForQuote(block, quote) : null) ?? block;
      }
      const p = root.getBoundingClientRect();
      return (
        head.getBoundingClientRect().top >= p.top + STICKY_HEADER_PX &&
        tail.getBoundingClientRect().bottom <= p.bottom
      );
    };
    const doScroll = shouldScroll && !anchorInView();
    // If the file is virtualized, scroll the anchor line on screen first — the
    // row is otherwise unmounted and no querySelector below would find it. The
    // virtualizer owns the scroll then (returns true); a short file / rendered
    // markdown returns false and we scroll to the row ourselves. A folded file
    // that locateFeedback just told to open registers a frame or two late, so
    // the retry below keeps re-issuing this until it takes. Only when scrolling.
    let scrolled = doScroll && scrollToLine(scrollKey, lineStart, side, { align: "center" });

    // Mark the anchored rows/block and return the first (or null if not yet
    // mounted). Re-runnable so we can retry until the virtualizer mounts the row.
    const mark = (): boolean => {
      const fileEl = root.querySelector(`${scopeSel}[data-file="${CSS.escape(file)}"]`);
      if (!fileEl) return false;
      let first: Element | null = null;
      for (let n = lineStart; n <= (lineEnd ?? lineStart); n++) {
        const el = side
          ? fileEl.querySelector(`[data-line="${n}"][data-side="${side}"]`)
          : fileEl.querySelector(`[data-line="${n}"]`);
        if (el) {
          el.classList.add("r3-active-line");
          first ??= el;
        }
      }
      // Markdown render has no per-line rows — ring the block the anchor falls in,
      // but highlight only the quoted text within it when we can find it (the
      // whole block is far wider than the anchor); the block is still the scroll
      // target either way. Blocks span data-line-start..data-line-end, so the
      // anchor line rarely equals a block's *start* line — find the block that
      // *contains* the range (same overlap test as the region highlight below),
      // not one starting exactly at lineStart, else the scroll misses and falls
      // back to the file top.
      if (!first) {
        const end = lineEnd ?? lineStart;
        let block: Element | null = null;
        for (const el of fileEl.querySelectorAll("[data-line-start]")) {
          const bs = Number(el.getAttribute("data-line-start"));
          const be = Number(el.getAttribute("data-line-end") ?? bs);
          if (bs <= end && be >= lineStart) {
            block = el;
            break;
          }
        }
        if (block) {
          const range = quote && supportsHighlights() ? rangeForQuote(block, quote) : null;
          if (range) setHighlightRanges(HL_ACTIVE, [range]);
          else block.classList.add("r3-active-line");
          first = block;
        }
      }
      if (!first) return false;
      // Bring the row into view only on a navigation, and only when the
      // virtualizer didn't already own the jump (a plain / folded / markdown file).
      if (doScroll && !scrolled) {
        const offset = first.getBoundingClientRect().top - root.getBoundingClientRect().top;
        root.scrollTo({
          top: root.scrollTop + offset - root.clientHeight * SCROLL_RATIO,
          behavior: "smooth",
        });
      }
      return true;
    };

    if (mark()) return () => setHighlightRanges(HL_ACTIVE, []);
    // Row not mounted yet — retry across a few frames while the target file
    // opens/mounts. When scrolling, re-issue the (live-rect-based, deterministic)
    // scroll each frame: for a virtualized jump, KEEP re-issuing for a settle
    // window past the first hit, since an unfolding file growing content above the
    // scroll position lets the browser's scroll anchoring drift the pane off the
    // target — re-asserting each frame overrides that; a DOM / rendered-markdown
    // scroll (mark self-scrolled, `scrolled` false) needs one hit. When NOT
    // scrolling we only wait to mark a late-mounting row, so stop the moment it's
    // marked. Budget covers the ~200ms unfold; an absent line gives up.
    let tries = 0;
    let foundAt = -1;
    let raf = requestAnimationFrame(function retry() {
      if (doScroll) scrolled = scrollToLine(scrollKey, lineStart, side) || scrolled;
      if (mark() && foundAt < 0) foundAt = tries;
      if (foundAt >= 0 && (!doScroll || !scrolled || tries - foundAt > 15)) return;
      if (++tries > 60) return;
      raf = requestAnimationFrame(retry);
    });
    return () => {
      cancelAnimationFrame(raf);
      setHighlightRanges(HL_ACTIVE, []);
    };
  }, [scope, fbId, file, side, lineStart, lineEnd, patchSeq, quote, scrollNonce, scrollToLine]);
}

// Locate the summary an active summary-feedback points at — the review summary
// (top of the file-viewer column, outside the scroll scope) or a round summary
// (inside it) — and bring it into view. Both summaries render as Markdown, so
// there are no per-line rows: highlight the exact `quote` within the rendered
// prose (best-effort, via the CSS Custom Highlight API) and scroll it on screen;
// fall back to flashing the whole block when the quote can't be found. A round
// summary is immutable so its quote always locates; the review summary is edited
// in place, so a drifted quote lands on the whole-block fallback (accepted).
// Separate from useActiveLineHighlight (which bails on SUMMARY_FILE) so the two
// never fight over the shared HL_ACTIVE registry.
function useActiveSummaryHighlight(
  scope: React.RefObject<HTMLElement | null>,
  fb: FeedbackWithReplies | null,
  scrollNonce: number,
) {
  const isSummary = fb?.file === SUMMARY_FILE;
  const fbId = fb?.id ?? null;
  const patchSeq = fb?.patch_seq ?? null;
  const quote = fb?.quote ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrollNonce is an intentional re-trigger dep
  useEffect(() => {
    for (const el of document.querySelectorAll(".r3-summary-active"))
      el.classList.remove("r3-summary-active");
    setHighlightRanges(HL_ACTIVE, []);
    if (!isSummary || fbId == null) return;
    const block =
      patchSeq == null
        ? document.querySelector('[data-summary="review"]')
        : (scope.current?.querySelector(`[data-round="${patchSeq}"] [data-summary="round"]`) ??
          null);
    if (!block) return;
    const range = quote && supportsHighlights() ? rangeForQuote(block, quote) : null;
    if (range) {
      setHighlightRanges(HL_ACTIVE, [range]);
      // scrollIntoView on the quote's element pulls it through every scroll
      // ancestor (the summary's own max-h scroll AND the pane), so it lands even
      // when the quote sits below the summary bar's internal fold.
      (range.startContainer.parentElement ?? block).scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    } else {
      block.classList.add("r3-summary-active");
      block.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    return () => setHighlightRanges(HL_ACTIVE, []);
  }, [scope, isSummary, fbId, patchSeq, quote, scrollNonce]);
}

interface Region {
  id: string;
  file: string;
  start: number;
  end: number;
  // The feedback's quote — its anchor of record. For rendered markdown we use it
  // to highlight the exact text, not the whole enclosing block (see mdhighlight).
  quote: string;
  // In a snapshot-diff view a row carries a side (old/new) and the line numbers
  // are per-side; a region resolved onto one side must only mark that side's rows.
  // Absent for plain file views (all rows are one side).
  side?: DiffSide | null;
}

// The narrowest region covering a line, so clicking a line that several feedbacks
// overlap jumps to the most specific one.
function tightest(regions: Region[]): Region {
  return regions.reduce((a, b) => (b.end - b.start < a.end - a.start ? b : a));
}

// Cross-browser caret hit-test: the (node, offset) directly under a viewport
// point. `caretPositionFromPoint` is the standard; `caretRangeFromPoint` is the
// older WebKit/Blink spelling — try the standard first, then fall back.
function caretNodeOffset(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos) return { node: pos.offsetNode, offset: pos.offset };
  const range = document.caretRangeFromPoint?.(x, y);
  if (range) return { node: range.startContainer, offset: range.startOffset };
  return null;
}

// A rendered-markdown block carries a *single* data-fb-id even when it spans
// several feedbacks' anchors (a whole <ul>/<ol>/<p>), so a click resolved by
// `closest` alone always lands on the first one. Refine it: when the tagged
// element is a markdown block (data-line-start) that more than one feedback
// overlaps, pick the feedback whose quote actually sits under the cursor. Code
// rows (data-line, tagged per-line already) have no data-line-start, so they pass
// straight through as `fallbackId`.
function refineMarkdownClick(
  holder: Element,
  x: number,
  y: number,
  regions: Region[],
  fallbackId: string | null,
): string | null {
  const bsAttr = holder.getAttribute("data-line-start");
  if (bsAttr == null) return fallbackId;
  const bs = Number(bsAttr);
  const be = Number(holder.getAttribute("data-line-end") ?? bsAttr);
  const file = holder.closest("[data-file]")?.getAttribute("data-file");
  const hits = regions.filter((r) => r.file === file && bs <= r.end && be >= r.start);
  if (hits.length <= 1) return fallbackId;
  const caret = caretNodeOffset(x, y);
  if (!caret) return fallbackId;
  for (const h of hits) {
    const range = rangeForQuote(holder, h.quote);
    if (range?.isPointInRange(caret.node, caret.offset)) return h.id;
  }
  return fallbackId;
}

// Persistently mark the lines/blocks that unresolved feedback points at (a steady
// region highlight, distinct from the transient active-line ring). Imperative,
// like useActiveLineHighlight — the content is server HTML — but re-applied on any
// content mutation (async blob load, fold/unfold, live update) via a
// MutationObserver, so the marks survive re-renders. childList/subtree only, so
// its own class edits (attribute mutations) don't retrigger it.
function useRegionHighlight(scope: React.RefObject<HTMLElement | null>, regions: Region[]) {
  useEffect(() => {
    const root = scope.current;
    if (!root) return;
    const byFile = new Map<string, Region[]>();
    for (const r of regions) {
      const arr = byFile.get(r.file);
      if (arr) arr.push(r);
      else byFile.set(r.file, [r]);
    }
    const apply = () => {
      for (const el of root.querySelectorAll(".r3-feedback-region"))
        el.classList.remove("r3-feedback-region");
      // data-fb-id tags the row/block a click should jump the panel to; re-derived
      // each pass so it tracks live changes to the feedback set.
      for (const el of root.querySelectorAll("[data-fb-id]")) el.removeAttribute("data-fb-id");
      // Precise text ranges for rendered-markdown feedback (see mdhighlight).
      const ranges: Range[] = [];
      for (const [file, rs] of byFile) {
        const fileEl = root.querySelector(`[data-file="${CSS.escape(file)}"]`);
        if (!fileEl) continue;
        // Code (and raw markdown) rows carry data-line (+ data-side in a diff). Tag
        // each with the tightest feedback covering it so a click jumps the panel to
        // the most specific one; a side-scoped region only marks its own side.
        for (const el of fileEl.querySelectorAll("[data-line]")) {
          const n = Number(el.getAttribute("data-line"));
          const side = el.getAttribute("data-side");
          const cover = rs.filter(
            (r) => n >= r.start && n <= r.end && (r.side == null || r.side === side),
          );
          if (cover.length === 0) continue;
          el.classList.add("r3-feedback-region");
          el.setAttribute("data-fb-id", tightest(cover).id);
        }
        // Rendered-markdown blocks span data-line-start..data-line-end — much
        // wider than the anchored text. Highlight each overlapping feedback's
        // exact quote inside the block; only fall back to washing the whole
        // block for a quote we can't locate (an outdated anchor) or where the
        // browser lacks the Custom Highlight API.
        for (const el of fileEl.querySelectorAll("[data-line-start]")) {
          const bs = Number(el.getAttribute("data-line-start"));
          const be = Number(el.getAttribute("data-line-end") ?? bs);
          const hits = rs.filter((r) => bs <= r.end && be >= r.start);
          if (hits.length === 0) continue;
          const foundIds: string[] = [];
          if (supportsHighlights()) {
            for (const h of hits) {
              const range = rangeForQuote(el, h.quote);
              if (range) {
                ranges.push(range);
                foundIds.push(h.id);
              }
            }
          }
          if (foundIds.length < hits.length) el.classList.add("r3-feedback-region");
          // Click target: prefer a feedback whose quote we actually highlighted.
          el.setAttribute("data-fb-id", foundIds[0] ?? hits[0].id);
        }
      }
      setHighlightRanges(HL_FEEDBACK, ranges);
    };
    let raf = 0;
    const schedule = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        apply();
      });
    };
    apply();
    const obs = new MutationObserver(schedule);
    obs.observe(root, { childList: true, subtree: true });
    return () => {
      obs.disconnect();
      if (raf) cancelAnimationFrame(raf);
      setHighlightRanges(HL_FEEDBACK, []);
    };
  }, [scope, regions]);
}

// A click-to-copy token in the header's metadata line (project dir, commit
// range, branch, session). Underlines on hover, copies `value` on click, and
// flashes a "Copied" bubble. The bubble is `position: fixed` (measured off the
// button rect) rather than absolute so it escapes the metadata line's `truncate`
// overflow-hidden clip.
function CopyMeta({
  value,
  hint,
  children,
}: {
  value: string;
  hint: string;
  children: React.ReactNode;
}) {
  const [tip, setTip] = useState<{ left: number; top: number } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const onClick = async (e: React.MouseEvent<HTMLButtonElement>) => {
    // Measure before awaiting — React nulls currentTarget after the handler.
    const r = e.currentTarget.getBoundingClientRect();
    if (!(await copyText(value))) return;
    setTip({ left: r.left + r.width / 2, top: r.top - 4 });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setTip(null), 1200);
  };
  return (
    <>
      <button
        type="button"
        onClick={onClick}
        title={hint}
        className="cursor-pointer rounded-sm hover:underline focus-visible:underline focus-visible:outline-none"
      >
        {children}
      </button>
      {tip && (
        <span
          role="status"
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded bg-neutral-800 px-1.5 py-0.5 font-sans text-[0.625rem] font-medium text-white shadow dark:bg-neutral-700"
          style={{ left: tip.left, top: tip.top }}
        >
          Copied
        </span>
      )}
    </>
  );
}

// The review title, editable in place: the text (falling back to the source
// label when untitled) with a hover pencil; click it or double-click the title
// to open an input. Enter / blur saves, Esc cancels. Passing null clears the
// title back to the source-label fallback.
function EditableTitle({
  title,
  placeholder,
  onSave,
}: {
  title: string | null;
  placeholder: string;
  onSave: (title: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(title ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  // Grow the input to fit its content so it hugs the text and widens only as the
  // user types, instead of stretching to fill the row. (width:0 → scrollWidth is
  // the standard auto-size trick; the browser paints once, so there's no flash.)
  const autoSize = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.width = "0";
    el.style.width = `${el.scrollWidth + 2}px`;
  }, []);

  const startEditing = () => {
    setDraft(title ?? "");
    setEditing(true);
  };
  useEffect(() => {
    if (editing) {
      autoSize();
      inputRef.current?.select();
    }
  }, [editing, autoSize]);

  const commit = () => {
    const trimmed = draft.trim();
    onSave(trimmed ? trimmed : null);
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        // biome-ignore lint/a11y/noAutofocus: focus the field the user just opened
        autoFocus
        ref={inputRef}
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          autoSize();
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") setEditing(false);
        }}
        placeholder={placeholder}
        // -my-px offsets the border so the editor is exactly the display height —
        // opening it never grows the row. Width auto-sizes to content (min keeps
        // it usable when empty, max keeps it inside the row).
        className="-my-px min-w-[3rem] max-w-full rounded border border-primary-400 bg-white px-1 text-sm font-semibold outline-none dark:bg-neutral-900"
      />
    );
  }
  return (
    <div className="group flex min-w-0 items-center gap-1">
      <button
        type="button"
        onClick={startEditing}
        title="Rename review"
        className="min-w-0 cursor-text truncate text-left text-sm font-semibold"
      >
        {title || placeholder}
      </button>
      <button
        type="button"
        onClick={startEditing}
        title="Rename review"
        className="shrink-0 text-neutral-400 opacity-0 transition-opacity hover:text-neutral-600 group-hover:opacity-100 dark:hover:text-neutral-300"
      >
        <svg
          viewBox="0 0 24 24"
          aria-hidden="true"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="size-3.5"
        >
          <path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z" />
          <path d="m15 5 4 4" />
        </svg>
      </button>
    </div>
  );
}

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

const TOOLBAR_BTN =
  "flex rounded p-1 text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 dark:hover:bg-neutral-800 dark:hover:text-neutral-200";

// Sticky strip above the file pane: jump to the previous/next file block and
// fold/unfold every file at once (icon-only; the titles carry the words), plus
// an optional right-docked slot for the multi-round diff switcher. The file
// buttons hide when there are no files (an empty diff round still shows the strip
// so its round switcher stays reachable).
function PaneToolbar({
  hasFiles,
  onJump,
  onFoldAll,
  right,
}: {
  hasFiles: boolean;
  onJump: (dir: 1 | -1) => void;
  onFoldAll: (mode: "fold" | "unfold") => void;
  right?: ReactNode;
}) {
  // h-8 matches the file header height so the file pane's two stacked bars (this
  // toolbar + each file header) read as one consistent header stack. Intra-panel
  // only — we deliberately DON'T match the feedback panel's bars across the split
  // (equal heights there read as one connected bar); those keep their own heights.
  return (
    <div className="flex h-8 shrink-0 items-center border-b border-neutral-300 bg-white px-1.5 dark:border-neutral-700 dark:bg-neutral-950">
      {hasFiles && (
        <>
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
        </>
      )}
      {/* Full-height, flush-right slot: `self-stretch` fills the bar's height and
          `-mr-1.5` cancels the toolbar's horizontal padding, so an embedded widget
          (the round switcher) reaches the bar's top/bottom/right edges. */}
      {right && <div className="-mr-1.5 ml-auto flex items-stretch self-stretch">{right}</div>}
    </div>
  );
}

// The approve confirmation: a small modal capturing optional "next steps for the
// agent", which `r3 watch` prints to the agent when it sees the approval. Empty
// is fine — approving with no note is the common case. Escape / backdrop / Cancel
// dismiss without approving.
function ApproveDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: (note: string) => void;
  onCancel: () => void;
}) {
  const [note, setNote] = useState("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* backdrop: a real button so a click outside cancels (no nested-click hacks) */}
      <button
        type="button"
        aria-label="Cancel"
        onClick={onCancel}
        className="absolute inset-0 cursor-default bg-black/30"
      />
      <div className="relative w-full max-w-md rounded-lg border border-neutral-300 bg-white p-4 shadow-xl dark:border-neutral-700 dark:bg-neutral-900">
        <h2 className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">
          Approve review
        </h2>
        <p className="mt-1 text-xs text-neutral-500 dark:text-neutral-400">
          Optionally leave next steps for the agent — delivered when it picks up the result.
        </p>
        <textarea
          // biome-ignore lint/a11y/noAutofocus: the dialog is opened by an explicit Approve click
          autoFocus
          value={note}
          onChange={(e) => setNote(e.target.value)}
          // ⌘/Ctrl+Enter approves without reaching for the mouse (the note is
          // optional, so no content guard — an empty note is the common case).
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onConfirm(note.trim());
            }
          }}
          placeholder="Next steps for the agent (optional)…"
          rows={3}
          className="mt-3 w-full resize-y rounded-md border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-800 placeholder:text-neutral-400 focus:border-primary-500 focus:outline-none dark:border-neutral-700 dark:bg-neutral-950 dark:text-neutral-100"
        />
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="success" onClick={() => onConfirm(note.trim())}>
            Approve
          </Button>
        </div>
      </div>
    </div>
  );
}

// Review-header status controls: the primary Approve/Reopen button, plus a ⋯
// menu holding the rarer, heavier actions (Abandon, Delete) so they don't crowd
// the header. Approve opens a confirm dialog (optional next-steps note); Delete
// is tinted danger-red — it destroys the review and its feedback. Same popover
// mechanics as the feedback card's ⋯ menu (click-catcher + Escape).
function HeaderActions({
  status,
  unresolvedCount,
  onSetStatus,
  onApprove,
  onDelete,
}: {
  status: ReviewStatus;
  // How many of the *human's* feedback items are still open (status !== "resolved"
  // && author === "human"). Approve is blocked while any remain — approving is the
  // review's terminal success, so it shouldn't skip past feedback that never got a
  // decision. Agent-authored notes (guidance, questions) rank into the attention
  // zone but must not block the human's terminal action: the server and CLI enforce
  // no gate at all, so this is purely a UI guardrail against skipping your own
  // undecided feedback, not the agent's.
  unresolvedCount: number;
  onSetStatus: (s: ReviewStatus) => void;
  onApprove: (note: string) => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <>
      {status === "open" ? (
        <Button
          variant="success"
          onClick={() => setApproveOpen(true)}
          disabled={unresolvedCount > 0}
          title={
            unresolvedCount > 0
              ? `Resolve your open feedback first — ${unresolvedCount} still ${unresolvedCount === 1 ? "needs a" : "need"} decision${unresolvedCount === 1 ? "" : "s"}`
              : undefined
          }
        >
          Approve
        </Button>
      ) : (
        <Button onClick={() => onSetStatus("open")}>Reopen</Button>
      )}
      <div className="relative">
        <Button variant="ghost" onClick={() => setMenuOpen((o) => !o)} title="More actions">
          ⋯
        </Button>
        {menuOpen && (
          <>
            {/* click-catcher: closes the menu when clicking elsewhere */}
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setMenuOpen(false)}
              className="fixed inset-0 z-40 cursor-default"
            />
            <div className="absolute top-full right-0 z-50 mt-1 w-32 overflow-hidden rounded-md border border-neutral-300 bg-white shadow-lg dark:border-neutral-700 dark:bg-neutral-950">
              {status === "open" && (
                <button
                  type="button"
                  onClick={() => {
                    onSetStatus("abandoned");
                    setMenuOpen(false);
                  }}
                  className="block w-full px-3 py-1.5 text-left text-xs hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  Abandon
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onDelete();
                }}
                className="block w-full px-3 py-1.5 text-left text-xs text-danger-500 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              >
                Delete
              </button>
            </div>
          </>
        )}
      </div>
      {approveOpen && (
        <ApproveDialog
          onCancel={() => setApproveOpen(false)}
          onConfirm={(note) => {
            setApproveOpen(false);
            onApprove(note);
          }}
        />
      )}
    </>
  );
}

// Focus the feedback panel's anchored composer (it lives outside the calling
// subtree, so it's reached by a data attr rather than a ref) and land the caret
// at the end. One rAF is enough: the draft-store write flushes its subscribers
// synchronously inside the click event, so the textarea is committed before the
// frame fires.
function focusComposer() {
  requestAnimationFrame(() => {
    const ta = document.querySelector<HTMLTextAreaElement>("textarea[data-anchored-composer]");
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  });
}

// Crossfade the content pane when the rendered version changes — a diff-round
// switch or a snapshot from/to change should read as a deliberate move, not a hard
// cut. Played imperatively (WAAPI) on the *existing* pane element so the
// virtualized file cards never remount: a remount would reset scroll position and
// each card's local fold state (worse than no animation). `key` encodes only the
// rendered version, so unrelated re-renders (SSE feedback, scroll-spy, theme
// refetch) don't fire it; a null key means "nothing rendered yet" and is skipped
// on both sides so an initial load or a loading gap never animates. Reduced-motion
// swaps instantly. No cleanup: the animation has fill:none and reverts to the
// pane's resting opacity of 1.
function usePaneCrossfade(ref: RefObject<HTMLElement | null>, key: string | null) {
  const prev = useRef<string | null>(null);
  useEffect(() => {
    const from = prev.current;
    prev.current = key;
    if (from == null || key == null || from === key) return;
    const el = ref.current;
    if (!el) return;
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches)
      return;
    for (const a of el.getAnimations()) a.cancel();
    el.animate([{ opacity: 0.4 }, { opacity: 1 }], { duration: 160, easing: "ease-out" });
  }, [ref, key]);
}

export function ReviewView({ reviewId }: { reviewId: string }) {
  const qc = useQueryClient();
  const scopeRef = useRef<HTMLDivElement>(null);
  // Owns the per-file scroll-to-line registry the virtualized code panes fill;
  // ReviewView renders the pane provider as a child, so it can't consume that
  // context and holds the registry here instead (used by the locate/pin jumps).
  const virt = useVirtualPaneController();
  // Fold/unfold broadcast to the file cards: the toolbar's fold-all, and the
  // path-scoped unfolds that a next/prev jump or a feedback-locate fires so a
  // folded target file opens (mounting its rows) before we scroll to its line.
  // A fresh nonce each time so repeating an action overrides hand-toggled folds.
  const [foldSignal, setFoldSignal] = useState<FoldSignal | null>(null);
  const ensureFileOpen = useCallback((path: string) => {
    setFoldSignal((s) => ({ mode: "unfold", nonce: (s?.nonce ?? 0) + 1, path }));
  }, []);
  // The in-progress anchored composer's target, persisted per review in the browser
  // (drafts.ts) so it hides on switch and restores on return. Subscribe to just the
  // anchor (not the whole draft record) so typing in the composer/reply/general
  // note doesn't re-render this whole view — the anchor ref is stable across those
  // edits. The composers own their own text, read straight from the store.
  const pending = useDraftAnchor(reviewId);
  const [activeFbId, setActiveFbId] = useState<string | null>(null);
  // Bumped by an explicit "jump to this feedback" click so re-clicking the
  // already-active feedback still re-scrolls.
  const [scrollNonce, setScrollNonce] = useState(0);
  const [activePath, setActivePath] = useState<string | null>(null);
  // Which diff round (patch) the tab strip has selected, for a multi-round diff
  // review — null until the human picks one, then `effectiveRoundSeq` resolves
  // it (falling back to the latest round). Only one round renders at a time, so
  // this also scopes the file browser + scroll-spy.
  const [activeRoundSeq, setActiveRoundSeq] = useState<number | null>(null);
  // Files-review snapshot picker: `fromSnap` null = None (no diff — a
  // plain view of `toSnap`); `toSnap` "WORKING" = the live content (the default).
  const [fromSnap, setFromSnap] = useState<number | null>(null);
  const [toSnap, setToSnap] = useState<SnapshotRef>("WORKING");
  const { isViewed, toggle: toggleViewed } = useViewedFiles(reviewId);
  // Loaded content shas for the live files view, reported up by each FileView, so
  // the file-tree's viewed markers (keyed by path) stay consistent with the cards'
  // sha-keyed marks. Only populated in the live plain view.
  const [shas, setShas] = useState<Map<string, string>>(new Map());
  const onSha = useCallback((path: string, sha: string) => {
    setShas((prev) => (prev.get(path) === sha ? prev : new Map(prev).set(path, sha)));
  }, []);
  // Drag-resizable feedback panel (right-docked → drag its left edge to widen).
  // Defaults to a golden split (panel = 0.382 of the row, file view = 0.618);
  // double-click the handle to reset.
  const splitRef = useRef<HTMLDivElement>(null);
  const {
    width: feedbackWidth,
    onPointerDown: onFeedbackResize,
    onDoubleClick: onFeedbackResetSplit,
  } = useResizableWidth("r3-feedback-width", {
    min: 280,
    max: 680,
    defaultFraction: 0.382,
    containerRef: splitRef,
  });

  const {
    data: detail,
    isLoading,
    error,
  } = useQuery({
    queryKey: ["review", reviewId],
    queryFn: () => api.review(reviewId),
    // A deleted review 404s — don't retry it, so the tab reacts promptly (the
    // guard below then swaps in the error screen). Other errors keep retrying.
    retry: (failureCount, err) =>
      err instanceof ApiError && err.status === 404 ? false : failureCount < 3,
  });

  // Live `r3 watch` presence — same query key as FeedbackPanel's, so this shares
  // the cache (no extra request) and only exists to flag watching in the tab title.
  const { data: watchersData } = useQuery({
    queryKey: ["watchers", detail?.id],
    queryFn: () => api.watchers(detail!.id),
    enabled: !!detail,
    refetchInterval: 30000,
    // Keep polling while the tab is hidden so the tab-title "watching" dot tracks
    // an agent that starts/stops watching in the background, where the browser may
    // suspend our SSE stream (the poll then re-syncs it without a tab switch).
    refetchIntervalInBackground: true,
  });
  const watching = (watchersData?.watchers.length ?? 0) > 0;

  const syntaxTheme = useSyntaxTheme();
  const isDiff = detail?.kind === "diff";
  // The review's stored rounds — one query regardless of how many
  // rounds exist; the server falls back to a live render for legacy reviews.
  const { data: diff, error: diffError } = useQuery({
    queryKey: ["review-diff", reviewId, syntaxTheme],
    queryFn: () => api.reviewDiff(reviewId, syntaxTheme),
    enabled: isDiff,
  });
  const rounds = diff?.rounds ?? [];
  // The round the tab strip shows: the human's pick if it still exists, else the
  // latest round (the newest work — what a reviewer coming back wants first). A
  // new round arriving over SSE never yanks an existing selection.
  const effectiveRoundSeq =
    activeRoundSeq != null && rounds.some((r) => r.seq === activeRoundSeq)
      ? activeRoundSeq
      : (rounds[rounds.length - 1]?.seq ?? null);

  // Files-review content snapshots. The from/to picker diffs any two
  // (or one vs. live); with none captured the picker is hidden and the view is the
  // classic live files view. `diffMode` = a `from` snapshot is picked.
  const snapshots = useMemo(() => (detail?.kind === "files" ? detail.snapshots : []), [detail]);
  const snapKey = snapshots.map((s) => s.seq).join(",");
  // Reset a from/to selection that no longer resolves — a snapshot removed, or the
  // review switched under a persisted component — back to None/live.
  // biome-ignore lint/correctness/useExhaustiveDependencies: snapKey encodes the snapshot set the selection must stay within
  useEffect(() => {
    if (fromSnap != null && !snapshots.some((s) => s.seq === fromSnap)) setFromSnap(null);
    if (toSnap !== "WORKING" && !snapshots.some((s) => s.seq === toSnap)) setToSnap("WORKING");
  }, [snapKey]);
  const diffMode = detail?.kind === "files" && fromSnap != null;
  const { data: snapDiff } = useQuery({
    queryKey: ["snapshot-diff", reviewId, fromSnap, toSnap, syntaxTheme],
    queryFn: () => api.snapshotDiff(reviewId, fromSnap as number, toSnap, syntaxTheme),
    enabled: diffMode,
  });
  // The derived diff wrapped as one synthetic round so DiffView renders it (same
  // gutter-drag feedback, folding, side-aware rows) with no round header.
  const snapRounds: PatchDiff[] = useMemo(
    () =>
      snapDiff
        ? [
            {
              seq: SNAPSHOT_DIFF_SEQ,
              label: null,
              summary: null,
              created_at: detail?.created_at ?? "",
              files: snapDiff.files,
            },
          ]
        : [],
    [snapDiff, detail?.created_at],
  );
  // Locate each files-review feedback in the current snapshot-diff by quote:
  // the canonical anchor is the live file, so per-side renumbered diff
  // rows can't be matched by line number — we find the quote among the diff rows.
  const diffPlacements = useMemo(() => {
    const m = new Map<string, Placement>();
    if (!diffMode || !snapDiff || !detail) return m;
    for (const fb of detail.feedback) {
      if (fb.file === SUMMARY_FILE || !fb.file || !fb.quote) continue;
      const p = placeInDiff(snapDiff.files, fb);
      if (p) m.set(fb.id, p);
    }
    return m;
  }, [diffMode, snapDiff, detail]);

  // The selected theme's editor background + default foreground, painted onto the
  // code surfaces (DiffView/FileView) via CSS vars so a theme looks like it does
  // in an editor. Same for every file, so it's fetched once per theme and set on
  // the content pane; descendants inherit. Falls back to the neutral card colour.
  const { data: themeStyle } = useQuery({
    queryKey: ["theme-style", syntaxTheme],
    queryFn: () => api.themeStyle(syntaxTheme),
    staleTime: Number.POSITIVE_INFINITY,
  });
  const surfaceVars = themeStyle
    ? ({
        "--shiki-light-bg": themeStyle.lightBg,
        "--shiki-dark-bg": themeStyle.darkBg,
        "--shiki-light": themeStyle.lightFg,
        "--shiki-dark": themeStyle.darkFg,
      } as CSSProperties)
    : undefined;

  // Derive the active feedback from the live detail by id, so live updates keep
  // it fresh without a sync effect.
  const activeFb: FeedbackWithReplies | null =
    detail?.feedback.find((f) => f.id === activeFbId) ?? null;
  // In a snapshot-diff view the active feedback is placed by quote onto a side of
  // the diff (its stored live line number doesn't apply there); feed the resolved
  // coords to the highlighter. Unplaced → null line so it rings nothing rather than
  // the wrong row. Plain views use the feedback as-is (server-anchored line).
  const activeFbHighlight = useMemo<FeedbackWithReplies | null>(() => {
    if (!activeFb || !diffMode) return activeFb;
    const p = diffPlacements.get(activeFb.id);
    if (!p) return { ...activeFb, line_start: null, line_end: null };
    return {
      ...activeFb,
      side: p.side,
      line_start: p.lineStart,
      line_end: p.lineEnd,
      patch_seq: SNAPSHOT_DIFF_SEQ,
    };
  }, [activeFb, diffMode, diffPlacements]);
  useActiveLineHighlight(scopeRef, activeFbHighlight, scrollNonce, virt.scrollToLine);
  useActiveSummaryHighlight(scopeRef, activeFb, scrollNonce);

  // The version the content pane currently renders: a diff review's active round,
  // else the files review's snapshot from/to selection (covers plain view, a pinned
  // snapshot, and a snapshot-diff). A diff review renders null while its rounds load
  // — skipped so the initial load (and a theme refetch that briefly drops `diff`)
  // doesn't count as a switch; a files selection always maps to a concrete key.
  const paneVersionKey = isDiff
    ? effectiveRoundSeq != null
      ? `d:${effectiveRoundSeq}`
      : null
    : `s:${fromSnap ?? "none"}:${toSnap}`;
  usePaneCrossfade(scopeRef, paneVersionKey);

  // Regions any unresolved (non-resolved) feedback anchors to, for a persistent
  // highlight in the file view. Diff reviews are excluded (side-aware rows).
  const rawRegions = useMemo<Region[]>(() => {
    if (!detail) return [];
    const out: Region[] = [];
    for (const fb of detail.feedback) {
      if (fb.status === "resolved" || !fb.file) continue;
      // Summary feedback points at prose (data-summary), not a file's data-line
      // rows — the file-region highlight can't place it, so skip it here.
      if (fb.file === SUMMARY_FILE) continue;
      if (detail.kind === "diff") {
        // Diff review: feedback anchors into an immutable stored round (patch_seq
        // + line/side). Only one round renders at a time and line numbers don't
        // carry across rounds, so mark only the feedback belonging to the round on
        // screen; the rest stay listed in the panel but unmarked here.
        if (fb.patch_seq !== effectiveRoundSeq || fb.line_start == null) continue;
        out.push({
          id: fb.id,
          file: fb.file,
          start: fb.line_start,
          end: fb.line_end ?? fb.line_start,
          quote: fb.quote ?? "",
          side: fb.side,
        });
      } else if (diffMode) {
        // Files review, snapshot-diff view: place by quote, onto the side it
        // lands on. Feedback whose quote isn't in this diff is listed, not marked.
        const p = diffPlacements.get(fb.id);
        if (!p) continue;
        out.push({
          id: fb.id,
          file: fb.file,
          start: p.lineStart,
          end: p.lineEnd,
          quote: fb.quote ?? "",
          side: p.side,
        });
      } else {
        // Files review, plain view: the server-anchored line (live content, or
        // approximate for a historical snapshot browse).
        if (fb.line_start == null) continue;
        out.push({
          id: fb.id,
          file: fb.file,
          start: fb.line_start,
          end: fb.line_end ?? fb.line_start,
          quote: fb.quote ?? "",
        });
      }
    }
    return out;
  }, [detail, diffMode, diffPlacements, effectiveRoundSeq]);
  // The regions recompute on every `detail` change (any SSE reply/status flip),
  // but their identity feeds useRegionHighlight's full DOM sweep. Stabilize it:
  // keep the previous array whenever the new one is structurally identical, so
  // the sweep only re-runs when the regions actually change. The digest is the
  // region tuples the sweep reads (id, file, line span, side, quote).
  const regionsKey = useMemo(
    () =>
      rawRegions
        .map((r) => `${r.id}\t${r.file}\t${r.start}\t${r.end}\t${r.side ?? ""}\t${r.quote}`)
        .join("\n"),
    [rawRegions],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: regionsKey is a structural digest of rawRegions — re-memoize only when the content changes, not on every new array identity
  const unresolvedRegions = useMemo(() => rawRegions, [regionsKey]);
  useRegionHighlight(scopeRef, unresolvedRegions);

  // Browser tab title: "<review name (truncated)> - <repo> - r3". App.tsx resets
  // it to "r3" when no review is open. A leading "• " mirrors the in-app "watching"
  // indicator so a backgrounded tab shows at a glance that an agent is watching
  // (and waiting on) this review. A small bullet, not U+25CF — the black circle
  // renders oversized in the tab strip.
  useEffect(() => {
    if (!detail) return;
    const name = detail.title || sourceLabel(detail, { ref: true });
    const short = name.length > 60 ? `${name.slice(0, 59)}…` : name;
    const base = [short, detail.repoName, "r3"].filter(Boolean).join(" - ");
    document.title = watching ? `• ${base}` : base;
  }, [detail, watching]);

  // Clicking a feedback card's file:line jumps the file pane to that line and
  // highlights it. Bumping the nonce re-scrolls even if it's already active.
  const locateFeedback = useCallback(
    (fb: FeedbackWithReplies | null) => {
      // null clears the active feedback (focus nothing) — e.g. after resolving the
      // last open item, with no next card to advance to.
      if (!fb) {
        setActiveFbId(null);
        return;
      }
      // Anchored to a specific round → select its tab first so that round's DOM is
      // mounted before the highlight effect (keyed on scrollNonce) queries + scrolls
      // to it; both state updates batch into one render, effects run after commit.
      if (fb.patch_seq != null) setActiveRoundSeq(fb.patch_seq);
      // A folded target file has no mounted rows to scroll to — open it first (the
      // highlight effect's retry then catches the row once it mounts). Summary
      // feedback points at prose, not a file, so there's nothing to unfold.
      if (fb.file && fb.file !== SUMMARY_FILE) ensureFileOpen(fb.file);
      setActiveFbId(fb.id);
      setScrollNonce((n) => n + 1);
    },
    [ensureFileOpen],
  );

  // The inverse of the above: click a highlighted region in the file pane to jump
  // the feedback panel to its feedback (regions carry data-fb-id, set by
  // useRegionHighlight). A *plain* click only — a drag that leaves a selection is
  // the "leave feedback" gesture; gutter clicks pick lines; links keep working.
  // A plain click that misses every region clears the active feedback, so clicking
  // blank file space unfocuses whichever card is currently highlighted.
  useEffect(() => {
    const root = scopeRef.current;
    if (!root) return;
    const onClick = (e: MouseEvent) => {
      const sel = window.getSelection();
      if (sel && !sel.isCollapsed) return;
      const target = e.target instanceof Element ? e.target : null;
      if (!target || target.closest("[data-gutter]") || target.closest("a")) return;
      const holder = target.closest("[data-fb-id]");
      const fallbackId = holder?.getAttribute("data-fb-id") ?? null;
      // A markdown block's one data-fb-id covers every feedback in it; resolve to
      // the one whose quote is actually under the cursor (no-op for code rows).
      const id = holder
        ? refineMarkdownClick(holder, e.clientX, e.clientY, unresolvedRegions, fallbackId)
        : null;
      const fb = id ? detail?.feedback.find((f) => f.id === id) : null;
      if (fb) locateFeedback(fb);
      else setActiveFbId(null);
    };
    root.addEventListener("click", onClick);
    return () => root.removeEventListener("click", onClick);
  }, [detail, locateFeedback, unresolvedRegions]);

  // The list of files shown in the center, for the file browser + scroll-spy.
  // For a diff review only the active round renders, so the browser lists that
  // round's files (a path recurring across rounds isn't a concern here).
  const filesSrc = detail && "files" in detail.source ? detail.source : null;
  const activeRound = isDiff ? rounds.find((r) => r.seq === effectiveRoundSeq) : null;
  // The files a plain (non-diff) view browses: the live membership at `to=Current`,
  // else the chosen snapshot's captured file set.
  const browseFiles: string[] =
    toSnap === "WORKING"
      ? (filesSrc?.files ?? [])
      : (snapshots.find((s) => s.seq === toSnap)?.files ?? []);
  // The files shown in the center, for the file browser + scroll-spy, per mode: a
  // diff review's active round, the snapshot-diff's changed files, or the plain
  // view's browse set.
  const fileList: string[] = isDiff
    ? (activeRound?.files.map((f) => f.path) ?? [])
    : diffMode
      ? (snapDiff?.files.map((f) => f.path) ?? [])
      : browseFiles;

  // Viewed paths for the file-tree, resolved through the same content-identity
  // keys the cards use: a diff review keys on the active
  // round; the live files view keys on each file's reported sha. Snapshot-diff and
  // pinned-snapshot views don't track viewed, so the tree shows none there either.
  const liveFilesView = !isDiff && !diffMode && toSnap === "WORKING";
  const viewedPaths = useMemo(() => {
    const s = new Set<string>();
    if (isDiff && effectiveRoundSeq != null) {
      for (const p of fileList) if (isViewed(diffViewedKey(effectiveRoundSeq, p))) s.add(p);
    } else if (liveFilesView) {
      for (const p of fileList) {
        const sha = shas.get(p);
        if (sha && isViewed(fileViewedKey(p, sha))) s.add(p);
      }
    }
    return s;
  }, [isDiff, effectiveRoundSeq, liveFilesView, fileList, shas, isViewed]);

  // In-flight toolbar scroll animation: the rAF handle (to cancel when a new
  // jump starts) and a flag the scroll-spy checks so mid-flight frames don't
  // overwrite the activePath the jump just set (rapid next/next must step from
  // the *target*, not from wherever the animation happens to be).
  const scrollAnim = useRef(0);
  const scrollAnimating = useRef(false);

  const scrollToFile = useCallback((path: string, opts?: { animate?: boolean }) => {
    const root = scopeRef.current;
    if (!root) return;
    const el = root.querySelector(`[data-file="${CSS.escape(path)}"]`);
    if (!el) return;
    cancelAnimationFrame(scrollAnim.current);
    scrollAnimating.current = false;
    if (opts?.animate) {
      // Toolbar next/prev: a short fixed-duration ease-out — smooth, but it
      // reaches the destination in ~200ms no matter how far. (Native
      // behavior:"smooth" is distance-scaled: it crawls through dozens of
      // Shiki-highlighted blocks.) The destination is re-measured every frame,
      // so it stays exact while the target block is still unfolding under it.
      const from = root.scrollTop;
      const start = performance.now();
      scrollAnimating.current = true;
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / 200);
        const eased = 1 - (1 - t) ** 3;
        const dest =
          root.scrollTop + el.getBoundingClientRect().top - root.getBoundingClientRect().top;
        root.scrollTop = from + (dest - from) * eased;
        if (t < 1) scrollAnim.current = requestAnimationFrame(step);
        else scrollAnimating.current = false;
      };
      scrollAnim.current = requestAnimationFrame(step);
    } else {
      // File-browser click: instant jump — an animation through an arbitrary
      // distance of highlighted code reads as lag. Set scrollTop directly
      // (block:"start" of the target relative to the scroll container).
      root.scrollTop += el.getBoundingClientRect().top - root.getBoundingClientRect().top;
    }
    setActivePath(path);
  }, []);

  // Toolbar: fold/unfold-all broadcast — a fresh nonce each click so repeating
  // the same action still overrides folds the user toggled by hand in between.
  const foldAll = useCallback((mode: "fold" | "unfold") => {
    setFoldSignal((s) => ({ mode, nonce: (s?.nonce ?? 0) + 1 }));
  }, []);

  // Toolbar: step to the adjacent file block, anchored on the scroll-spy's
  // current file so it follows wherever the user has scrolled to. The target
  // unfolds as we travel to it (path-scoped signal), and the ride is animated.
  const jumpFile = useCallback(
    (dir: 1 | -1) => {
      if (fileList.length === 0) return;
      const idx = activePath ? fileList.indexOf(activePath) : -1;
      const next =
        idx === -1
          ? dir === 1
            ? 0
            : fileList.length - 1
          : Math.min(fileList.length - 1, Math.max(0, idx + dir));
      const target = fileList[next];
      ensureFileOpen(target);
      scrollToFile(target, { animate: true });
    },
    [fileList, activePath, scrollToFile, ensureFileOpen],
  );

  // Scroll-spy: mark the file whose block currently sits at the top of the pane.
  // The listener reads the DOM live, so it stays correct as blocks load/render
  // without re-subscribing. Keyed on `detail` (not []) because the first commit
  // early-returns "Loading review…" — scopeRef is null there, and a one-shot
  // effect would never attach on a cold load.
  // biome-ignore lint/correctness/useExhaustiveDependencies: detail is the re-attach trigger; the listener reads the DOM, not the object
  useEffect(() => {
    const root = scopeRef.current;
    if (!root) return;
    let raf = 0;
    const measure = () => {
      raf = 0;
      // A toolbar jump owns activePath while its animation flies — mid-flight
      // frames must not re-spy it back to a block the ride is passing through.
      if (scrollAnimating.current) return;
      const top = root.getBoundingClientRect().top;
      const blocks = root.querySelectorAll("[data-file]");
      let current: string | null = blocks[0]?.getAttribute("data-file") ?? null;
      for (const b of blocks) {
        if (b.getBoundingClientRect().top - top <= 8) current = b.getAttribute("data-file");
        else break;
      }
      setActivePath(current);
    };
    // rAF-throttle: a wheel/trackpad flick fires many scroll events per frame, but
    // the spy only needs to run once per painted frame. Coalesce them so a fast
    // scroll doesn't repeat the querySelectorAll + getBoundingClientRect sweep
    // dozens of times between frames.
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(measure);
    };
    root.addEventListener("scroll", onScroll, { passive: true });
    measure();
    return () => {
      root.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [detail]);

  // A floating "Quote in note" bubble raised over the file pane when a selection
  // or line-pick is made while the anchored composer already holds text (see
  // applyAnchorGesture). Fixed-positioned off the selection / first-row rect.
  const [fileQuote, setFileQuote] = useState<QuotePos | null>(null);

  // The one anchor gesture — a text selection OR a gutter line-pick, routed the
  // same way, optimized for the common case:
  //   • no anchored composer open       → open one on the selection
  //   • composer open, note still empty → re-anchor it to the selection
  //   • composer open, note has text    → never clobber the note; raise the
  //     "Quote in note" bubble so the selected code drops in as a `>` blockquote.
  // This kills the old footgun where selecting code to copy silently repointed a
  // half-written note. `rect` positions the bubble.
  const applyAnchorGesture = useCallback(
    (anchor: PendingAnchor, quoteText: string, rect: { left: number; top: number } | null) => {
      const d = getDraft(reviewId);
      const composing = d?.anchor != null && (d.text ?? "").trim() !== "";
      if (composing) {
        if (rect && quoteText.trim())
          setFileQuote({ left: rect.left, top: rect.top, text: quoteText });
        return; // a note is in progress — leave its anchor alone
      }
      setFileQuote(null);
      setDraftAnchor(reviewId, anchor);
    },
    [reviewId],
  );

  const onPickLines = useCallback(
    (
      file: string,
      side: DiffSide,
      lineStart: number,
      lineEnd: number,
      quote: string,
      patchSeq?: number,
    ) => {
      const anchor = { file, side, lineStart, lineEnd, quote, patchSeq };
      // Where a quote bubble would sit: centered over the first picked row.
      const root = scopeRef.current;
      const scope = patchSeq != null ? `[data-round="${patchSeq}"] ` : "";
      const base = `${scope}[data-file="${CSS.escape(file)}"]`;
      const rowEl =
        root?.querySelector(`${base} [data-line="${lineStart}"][data-side="${side}"]`) ??
        root?.querySelector(`${base} [data-line="${lineStart}"]`);
      const r = rowEl?.getBoundingClientRect();
      const rect = r ? { left: r.left + Math.min(r.width, 320) / 2, top: r.top } : null;
      applyAnchorGesture(anchor, quote, rect);
    },
    [applyAnchorGesture],
  );

  // The file header's feedback button: open the composer anchored to the whole
  // file (no line span, no quote — the file itself is the anchor). `patchSeq`
  // names the diff round the button lives in; the server drops it to null when it
  // doesn't name a stored round (files reviews, snapshot-diff view).
  const onFileFeedback = useCallback(
    (file: string, patchSeq?: number) => {
      setDraftAnchor(reviewId, {
        file,
        side: null,
        lineStart: null,
        lineEnd: null,
        quote: null,
        patchSeq,
      });
    },
    [reviewId],
  );

  // Jump to a reply pin ("addressed in diff N"): scroll the pinned row into
  // view, preferring the new side — pins point at the fix, not the old code.
  const locatePin = useCallback(
    (patchSeq: number, file: string | null, line: number | null) => {
      // The pin usually names a different round than the one on screen — select
      // its tab, and open the pinned file if it's folded, then scroll to the row.
      setActiveRoundSeq(patchSeq);
      if (file) ensureFileOpen(file);
      // Retry across a few frames while the round tab + a folded/virtualized file
      // mount: re-issue the virtualizer scroll until it registers, else scroll to
      // the DOM row once it exists (waiting for it before settling for the file
      // top). Bounded to cover the ~200ms unfold.
      let tries = 0;
      let scrolledAt = -1;
      const step = () => {
        const root = scopeRef.current;
        if (!root) return;
        // A virtualized file's pinned row may be unmounted — let its virtualizer
        // bring it on screen (pins point at the fix, so prefer the new side). Keep
        // re-issuing for a settle window past the first hit so scroll anchoring
        // can't drift the pane off as an unfolding file grows. Returns false for a
        // short / non-virtualized file → the DOM scroll below.
        if (
          file != null &&
          line != null &&
          virt.scrollToLine(fileScrollKey(patchSeq, file), line, "new")
        ) {
          if (scrolledAt < 0) scrolledAt = tries;
          if (tries - scrolledAt > 15) return;
          tries++;
          requestAnimationFrame(step);
          return;
        }
        const roundSel = `[data-round="${patchSeq}"]`;
        const fileEl = file
          ? root.querySelector(`${roundSel} [data-file="${CSS.escape(file)}"]`)
          : root.querySelector(roundSel);
        if (fileEl) {
          const row =
            line != null
              ? (fileEl.querySelector(`[data-line="${line}"][data-side="new"]`) ??
                fileEl.querySelector(`[data-line="${line}"]`))
              : null;
          // Line named but its row hasn't mounted yet (file still opening) — wait
          // a few frames before settling for the file top.
          if (!row && line != null && ++tries <= 45) {
            requestAnimationFrame(step);
            return;
          }
          const target = row ?? fileEl;
          const offset = target.getBoundingClientRect().top - root.getBoundingClientRect().top;
          root.scrollTo({
            top: root.scrollTop + offset - root.clientHeight * SCROLL_RATIO,
            behavior: "smooth",
          });
          return;
        }
        if (++tries <= 45) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
    [virt.scrollToLine, ensureFileOpen],
  );

  // Jump the pane to an `@path:Lx-y` ref clicked inside a rendered message,
  // resolved against the message's pinned `version` (a reply's ref_version, or a
  // feedback body's round). A diff review reuses the immutable round pin jump; a
  // files review whose ref names a content snapshot switches the pane to a plain
  // view of that snapshot first (its line numbers are what the ref was written
  // against), else scrolls the live file.
  const jumpToRef = useCallback(
    (ref: MessageRef, version: number | null) => {
      if (isDiff) {
        locatePin(version ?? effectiveRoundSeq ?? 0, ref.file, ref.lineStart);
        return;
      }
      // A snapshot-pinned ref: show that snapshot plainly so the line lands right.
      if (version != null && snapshots.some((s) => s.seq === version)) {
        setFromSnap(null);
        setToSnap(version);
      }
      ensureFileOpen(ref.file);
      let tries = 0;
      let scrolledAt = -1;
      const step = () => {
        const root = scopeRef.current;
        if (!root) return;
        if (virt.scrollToLine(fileScrollKey(null, ref.file), ref.lineStart, null)) {
          if (scrolledAt < 0) scrolledAt = tries;
          if (tries - scrolledAt > 15) return;
          tries++;
          requestAnimationFrame(step);
          return;
        }
        const fileEl = root.querySelector(`[data-file="${CSS.escape(ref.file)}"]`);
        if (fileEl) {
          const row = fileEl.querySelector(`[data-line="${ref.lineStart}"]`);
          if (!row && ++tries <= 45) {
            requestAnimationFrame(step);
            return;
          }
          const target = row ?? fileEl;
          const offset = target.getBoundingClientRect().top - root.getBoundingClientRect().top;
          root.scrollTo({
            top: root.scrollTop + offset - root.clientHeight * SCROLL_RATIO,
            behavior: "smooth",
          });
          return;
        }
        if (++tries <= 45) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
    [isDiff, locatePin, effectiveRoundSeq, snapshots, ensureFileOpen, virt.scrollToLine],
  );

  // "Quote in note": drop the file-pane selection into the anchored note as a `>`
  // blockquote, then focus the composer. It lives in the feedback panel (out of
  // this subtree), so it's reached by its data attr rather than a ref.
  const quoteIntoNote = useCallback(
    (text: string) => {
      const cur = getDraft(reviewId)?.text ?? "";
      setDraftText(reviewId, quoteBlock(cur, text).text);
      setFileQuote(null);
      window.getSelection()?.removeAllRanges();
      focusComposer();
    },
    [reviewId],
  );

  // Dismiss the file-pane quote bubble once its fixed position would go stale (the
  // pane scrolled) or the selection collapsed.
  useEffect(() => {
    if (!fileQuote) return;
    const root = scopeRef.current;
    const onScroll = () => setFileQuote(null);
    const onSel = () => {
      const s = window.getSelection();
      if (!s || s.isCollapsed) setFileQuote(null);
    };
    root?.addEventListener("scroll", onScroll, { passive: true });
    document.addEventListener("selectionchange", onSel);
    return () => {
      root?.removeEventListener("scroll", onScroll);
      document.removeEventListener("selectionchange", onSel);
    };
  }, [fileQuote]);

  // Anchor a draft to whatever text is selected in the file view. Listen at the
  // document level, not on the scroll pane: a selection drag can end anywhere —
  // notably over the feedback panel — where the pane's own mouseup never fires,
  // which is why re-selecting near the panel edge used to leave the pending
  // draft stuck on the old region. getSelectionAnchor returns null unless the
  // selection actually lands on a file line, so clicks and panel-internal
  // selections are ignored.
  useEffect(() => {
    const onMouseUp = () => {
      const root = scopeRef.current;
      if (!root) return;
      const a = getSelectionAnchor(root);
      if (!a) return;
      const sel = window.getSelection();
      const text = sel?.toString() ?? "";
      let rect: { left: number; top: number } | null = null;
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        rect = { left: r.left + r.width / 2, top: r.top };
      }
      applyAnchorGesture(a, text, rect);
    };
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
  }, [applyAnchorGesture]);

  // Cancel/✕/Esc discards the anchored composer; a draft with text confirms first
  // (4). Only the anchored composer is dropped — a general note or drafted reply on
  // the same review is left untouched.
  const discardPending = useCallback(() => {
    // Cancel/✕ discards immediately — no confirm, matching the general note's close.
    // Esc already preserves a non-empty note (it only blurs, never discards), so the
    // deliberate Cancel/✕ click is the discard path and doesn't need a guard.
    dropAnchor(reviewId);
  }, [reviewId]);

  // Stable handler so the memoized FeedbackPanel isn't re-rendered on every
  // scroll-spy activePath change. A committed add drops the anchored composer but
  // keeps any general/reply drafts on the review.
  const onSubmittedPending = useCallback(() => dropAnchor(reviewId), [reviewId]);

  // Leaving the review (remount on switch) drops a text-less anchor so an empty
  // composer doesn't linger/reopen; a draft with text (of any kind) stays persisted.
  useEffect(() => {
    return () => {
      const d = getDraft(reviewId);
      if (d && d.text.trim() === "") dropAnchor(reviewId);
    };
  }, [reviewId]);

  const setStatus = useMutation({
    mutationFn: (body: UpdateReviewBody) => api.patchReview(reviewId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["review", reviewId] });
      qc.invalidateQueries({ queryKey: ["reviews"] });
    },
  });
  // Rename (title) goes through PATCH; the server also broadcasts review-updated
  // so other tabs + the reviews list refresh live. (The summary is CLI-only — set it
  // with `r3 edit --summary` — so the UI never PATCHes it.)
  const patch = useMutation({
    mutationFn: (body: { title?: string | null }) => api.patchReview(reviewId, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["review", reviewId] });
      qc.invalidateQueries({ queryKey: ["reviews"] });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteReview(reviewId),
    onSuccess: () => {
      clearDraft(reviewId); // no orphaned draft for a deleted review
      qc.invalidateQueries({ queryKey: ["reviews"] });
      navigate("/");
    },
  });

  // Replace the view with an error when there's no data at all (a first-load
  // failure from a stale URL) OR when the open review was deleted out from under
  // us — a 404 on refetch, even though TanStack still holds the last-good detail.
  // A transient refetch error over a loaded review is otherwise ignored (the
  // stale view beats a flicker).
  const gone = error instanceof ApiError && error.status === 404;
  if ((error && !detail) || gone)
    return (
      <div className="flex h-full flex-col items-start gap-3 p-6">
        <p className="text-sm text-danger-500">{(error as Error).message}</p>
        <Button onClick={() => navigate("/")}>← Back to reviews</Button>
      </div>
    );
  if (isLoading || !detail)
    return <div className="p-6 text-sm text-neutral-400">Loading review…</div>;

  // Copyable metadata-line values. The project dir is the review's worktree (an
  // absolute path); `commit` is the diff review's base/head provenance (raw
  // refs, not the shortened display shas), split into three copy targets below.
  const projectDir = detail.worktree?.pathHint || null;
  const commit =
    "base" in detail.source && (detail.source.base || detail.source.head) ? detail.source : null;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-2 border-b border-neutral-300 bg-white px-3 py-2 dark:border-neutral-700 dark:bg-neutral-950">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "shrink-0 rounded border px-1.5 py-0.5 text-[0.6875rem] font-semibold uppercase leading-none",
                detail.status === "open"
                  ? "border-transparent bg-primary-100 text-primary-700 dark:bg-primary-950 dark:text-primary-300"
                  : detail.status === "approved"
                    ? "border-success-500 bg-success-50 text-success-700 dark:border-success-500 dark:bg-success-950 dark:text-success-300"
                    : "border-transparent bg-neutral-200 text-neutral-500 dark:bg-neutral-800",
              )}
            >
              {detail.status}
            </span>
            <EditableTitle
              title={detail.title}
              placeholder={sourceLabel(detail, { ref: true })}
              onSave={(title) => patch.mutate({ title })}
            />
          </div>
          <div className="truncate font-mono text-[0.6875rem] text-neutral-400">
            {detail.repoName ? (
              <>
                {projectDir ? (
                  <CopyMeta value={projectDir} hint={`Copy path: ${projectDir}`}>
                    {detail.repoName}
                  </CopyMeta>
                ) : (
                  detail.repoName
                )}
                {" · "}
              </>
            ) : (
              ""
            )}
            {detail.kind} ·{" "}
            {commit ? (
              <>
                <CopyMeta value={commit.base} hint={`Copy base commit: ${commit.base}`}>
                  {shortSha(commit.base)}
                </CopyMeta>
                <CopyMeta
                  value={`${commit.base}..${commit.head}`}
                  hint={`Copy commit range: ${commit.base}..${commit.head}`}
                >
                  ..
                </CopyMeta>
                <CopyMeta value={commit.head} hint={`Copy head commit: ${commit.head}`}>
                  {shortSha(commit.head)}
                </CopyMeta>
              </>
            ) : (
              sourceLabel(detail, { ref: true })
            )}
            {detail.branch ? (
              <>
                {" · ⎇ "}
                <CopyMeta value={detail.branch} hint={`Copy branch: ${detail.branch}`}>
                  {detail.branch}
                </CopyMeta>
              </>
            ) : (
              ""
            )}
            {detail.meta.session ? (
              <>
                {" · "}
                <CopyMeta value={detail.meta.session} hint={`Copy: ${detail.meta.session}`}>
                  {detail.meta.session}
                </CopyMeta>
              </>
            ) : (
              ""
            )}
          </div>
        </div>
        <HeaderActions
          status={detail.status}
          unresolvedCount={
            detail.feedback.filter((f) => f.status !== "resolved" && f.author === "human").length
          }
          onSetStatus={(s) => setStatus.mutate({ status: s })}
          onApprove={(note) => setStatus.mutate({ status: "approved", note: note || null })}
          onDelete={() => {
            if (confirm("Delete this review and all its feedback?")) remove.mutate();
          }}
        />
      </div>

      {detail.stale && (
        <div className="shrink-0 border-b border-warning-300 bg-warning-50 px-4 py-2 text-xs text-warning-800 dark:border-warning-900/60 dark:bg-warning-950/40 dark:text-warning-300">
          ⚠ This review's worktree isn't available (moved, removed, or the repo path is missing).
          Showing last-known state — relink the project from the reviews list (the "Reviews" link)
          to restore live content.
        </div>
      )}
      {detail.scratchIgnoredDirs.length > 0 && (
        <div className="shrink-0 border-b border-warning-300 bg-warning-50 px-4 py-2 text-xs text-warning-800 dark:border-warning-900/60 dark:bg-warning-950/40 dark:text-warning-300">
          ⚠ Scratch reviews are flat —{" "}
          {detail.scratchIgnoredDirs.length === 1 ? "subdirectory" : "subdirectories"}{" "}
          <span className="font-mono">{detail.scratchIgnoredDirs.join(", ")}</span>{" "}
          {detail.scratchIgnoredDirs.length === 1 ? "is" : "are"} ignored (not shown or watched).
          Move files to the top level of the scratch directory.
        </div>
      )}
      <div ref={splitRef} className="flex min-h-0 flex-1">
        {fileList.length > 0 && (
          <FileBrowser
            files={fileList}
            viewed={viewedPaths}
            activePath={activePath}
            onSelect={scrollToFile}
          />
        )}
        {/* Content column: a diff review with more than one round gets a round
            switcher above the scroll pane so the file panel shows a single round
            at a time (the pane stays scrollable under it). */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* The review summary docks at the top of the file-viewer column rather
              than full-width above the split: its prose is width-capped, so the
              extra width the full span bought was wasted whitespace on the right.
              Refs pin no version (the summary is edited in place), so they resolve
              against the live/current view: null → the round on screen for a diff
              review, the live file for a files review. */}
          <ReviewSummary
            summary={detail.summary}
            onJumpRef={(ref) => jumpToRef(ref, null)}
            onAnchorSummary={applyAnchorGesture}
          />
          {/* Pinned above the scroll pane (not sticky inside it), so it never
              competes with the file headers' own sticky top-0. A multi-round diff
              docks its round switcher to the right; an empty round still shows the
              strip so the switcher stays reachable. */}
          {(fileList.length > 0 || (isDiff && rounds.length > 1) || snapshots.length > 0) && (
            <PaneToolbar
              hasFiles={fileList.length > 0}
              onJump={jumpFile}
              onFoldAll={foldAll}
              right={
                isDiff && rounds.length > 1 ? (
                  <RoundSelect
                    rounds={rounds}
                    activeSeq={effectiveRoundSeq}
                    onSelect={setActiveRoundSeq}
                  />
                ) : snapshots.length > 0 ? (
                  <SnapshotSelect
                    snapshots={snapshots}
                    from={fromSnap}
                    to={toSnap}
                    onFromChange={setFromSnap}
                    onToChange={setToSnap}
                  />
                ) : undefined
              }
            />
          )}
          {/* shiki-surface paints the pane in the syntax theme's own editor
              background, so the full-bleed file blocks read as one continuous
              full-height surface (no card insets, nothing peeking around them). */}
          <div
            ref={scopeRef}
            className="shiki-surface min-w-0 flex-1 overflow-y-auto"
            style={surfaceVars}
          >
            <VirtualPaneProvider scrollRef={scopeRef} registry={virt.registry}>
              {isDiff && diff && (
                <DiffView
                  rounds={rounds}
                  activeSeq={effectiveRoundSeq}
                  isViewed={isViewed}
                  toggle={toggleViewed}
                  onPickLines={onPickLines}
                  onFileFeedback={onFileFeedback}
                  onAnchorSummary={applyAnchorGesture}
                  onJumpRef={(ref, seq) => jumpToRef(ref, seq)}
                  foldSignal={foldSignal}
                />
              )}
              {isDiff && !diff && (
                <p
                  className={cn("p-6 text-sm", diffError ? "text-danger-500" : "text-neutral-400")}
                >
                  {diffError ? (diffError as Error).message : "Loading diff…"}
                </p>
              )}

              {/* Files review, diff mode: the derived snapshot→snapshot (or
                snapshot→live) diff, rendered through DiffView as one synthetic
                round. Feedback is placed onto it by quote. */}
              {!isDiff &&
                diffMode &&
                (snapDiff ? (
                  <DiffView
                    rounds={snapRounds}
                    activeSeq={SNAPSHOT_DIFF_SEQ}
                    // No viewed tracking in a files review's derived diff;
                    // omitting isViewed/toggle hides the toggle.
                    onPickLines={onPickLines}
                    onFileFeedback={onFileFeedback}
                    // Synthetic snapshot-diff rounds carry no summary, so the
                    // round-summary anchor/ref paths never fire here — wire the
                    // gesture for parity anyway.
                    onAnchorSummary={applyAnchorGesture}
                    foldSignal={foldSignal}
                  />
                ) : (
                  <p className="p-6 text-sm text-neutral-400">Loading diff…</p>
                ))}

              {/* Files review, plain view: the live files (to=Current) or a chosen
                snapshot's captured content (to=snapshot N). */}
              {!isDiff &&
                !diffMode &&
                filesSrc &&
                filesSrc.files.length === 0 &&
                toSnap === "WORKING" &&
                detail.scratchDir && (
                  <div className="p-8 text-center text-sm text-neutral-400">
                    <p className="font-medium text-neutral-500 dark:text-neutral-400">
                      No files yet
                    </p>
                    <p className="mt-1">
                      Drop files into this scratch directory — they appear here live:
                    </p>
                    <code className="mt-2 inline-block rounded bg-neutral-100 px-2 py-1 font-mono text-xs text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                      {detail.scratchDir}
                    </code>
                  </div>
                )}
              {!isDiff &&
                !diffMode &&
                filesSrc &&
                browseFiles.map((f) => (
                  <FileView
                    key={f}
                    path={f}
                    refName={filesSrc.ref}
                    reviewId={reviewId}
                    snapshotSeq={toSnap === "WORKING" ? undefined : toSnap}
                    // Viewed only in the live view: a
                    // parent-computed per-file boolean (keyed through the reported
                    // sha in viewedPaths) plus the stable toggle. A pinned snapshot
                    // browse omits the toggle, hiding it.
                    viewed={liveFilesView ? viewedPaths.has(f) : false}
                    toggle={liveFilesView ? toggleViewed : undefined}
                    onSha={liveFilesView ? onSha : undefined}
                    onPickLines={onPickLines}
                    onFileFeedback={onFileFeedback}
                    foldSignal={foldSignal}
                  />
                ))}
            </VirtualPaneProvider>
          </div>
        </div>

        <div
          className="relative shrink-0 border-l-2 border-neutral-300 bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900"
          style={{ width: feedbackWidth }}
        >
          {/* Drag handle straddling the left border; grabs a 8px strip and
              widens the panel as you pull it left. Double-click resets the split. */}
          <div
            onPointerDown={onFeedbackResize}
            onDoubleClick={onFeedbackResetSplit}
            title="Drag to resize · double-click to reset"
            className="absolute inset-y-0 -left-1 z-20 w-2 cursor-col-resize transition-colors hover:bg-primary-400/40"
          />
          <FeedbackPanel
            detail={detail}
            pending={pending}
            onDiscardPending={discardPending}
            onSubmittedPending={onSubmittedPending}
            activeFeedbackId={activeFbId}
            scrollNonce={scrollNonce}
            onLocateFeedback={locateFeedback}
            onLocatePin={locatePin}
            onJumpRef={jumpToRef}
          />
        </div>
      </div>
      {/* "Quote in note" bubble for a file-pane selection made while the anchored
          composer already holds text — fixed-positioned, so it lives at the root. */}
      {fileQuote && <QuoteBubble pos={fileQuote} label="Quote in note" onQuote={quoteIntoNote} />}
    </div>
  );
}
