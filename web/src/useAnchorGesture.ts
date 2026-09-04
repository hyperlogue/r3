// The one anchor gesture, and the transient UI it raises.
//
// Selecting text in the file pane, dragging the gutter, selecting inside a
// summary, and tapping the touch pill all mean the same thing — "this spot" — so
// they route through one decision (`anchorGestureFor`, in anchorGesture.ts)
// rather than four. This hook is that decision wired to the draft store and the
// pane: the pixel bookkeeping it implies — where a floating composer or quote
// bubble hangs, and when each stops being valid.

import { type RefObject, useCallback, useEffect, useState } from "react";
import {
  anchorGestureFor,
  anchorRectFor,
  FILE_ANCHOR_WIDTH,
  FILE_HEADER_HEIGHT,
  ROW_ANCHOR_WIDTH,
} from "./anchorGesture.ts";
import type { QuotePos } from "./components/Message.tsx";
import { quoteBlock } from "./components/Message.tsx";
import { dropAnchor, getDraft, setDraftAnchor, setDraftText } from "./drafts.ts";
import { focusComposer } from "./pane.ts";
import type { AnchorRect, PendingAnchor } from "./selection.ts";
import { getSelectionAnchor } from "./selection.ts";
import type { DiffSide } from "./types.ts";

export interface AnchorGesture {
  /** Where the gesture that opened the composer happened (see AnchorRect). */
  composerAt: AnchorRect | null;
  /** The "Quote in note" bubble's position, when a gesture raised one. */
  fileQuote: QuotePos | null;
  /** Route any anchor gesture (selection, gutter pick, summary) through here. */
  apply: (anchor: PendingAnchor, quoteText: string, rect: AnchorRect | null) => void;
  /** A gutter line-pick in the file/diff pane. */
  onPickLines: (
    file: string,
    side: DiffSide,
    lineStart: number,
    lineEnd: number,
    quote: string,
    patchSeq?: number,
  ) => void;
  /** The file header's feedback button: the file itself is the anchor. */
  onFileFeedback: (file: string, patchSeq?: number) => void;
  /** Drop the selection into the anchored note as a `>` blockquote. */
  quoteIntoNote: (text: string) => void;
  /** Discard just the anchored composer, leaving general/reply drafts alone. */
  discard: () => void;
}

export function useAnchorGesture(input: {
  reviewId: string;
  /** The content pane, for locating a picked row / file card. */
  scopeRef: RefObject<HTMLElement | null>;
  /** Coarse pointers never fire a usable mouseup — AddFeedbackPill drives those. */
  coarse: boolean;
  /** Mobile: raise the composer peek when one opens, retire it when one finishes. */
  onCompose: () => void;
  onSettle: () => void;
}): AnchorGesture {
  const { reviewId, scopeRef, coarse, onCompose, onSettle } = input;
  // A floating "Quote in note" bubble over the file pane, raised when a gesture
  // lands on a composer that already holds text. Fixed-positioned off the
  // selection / first-row rect.
  const [fileQuote, setFileQuote] = useState<QuotePos | null>(null);
  // Only the collapsed panel reads `composerAt` (it floats the composer there
  // instead of docking it at the bottom of a list that isn't on screen), but it's
  // measured on every gesture regardless: collapsing mid-compose must not leave
  // the composer with nowhere to go. Cleared with the anchor.
  const [composerAt, setComposerAt] = useState<AnchorRect | null>(null);

  const apply = useCallback(
    (anchor: PendingAnchor, quoteText: string, rect: AnchorRect | null) => {
      const action = anchorGestureFor(getDraft(reviewId), quoteText, rect);
      if (action.kind !== "anchor") {
        // A note is in progress — leave its anchor alone.
        if (action.kind === "quote") setFileQuote(action.pos);
        return;
      }
      setFileQuote(null);
      setComposerAt(rect);
      setDraftAnchor(reviewId, anchor);
      onCompose();
    },
    [reviewId, onCompose],
  );

  // Find a target box in the pane, scoped to its round when it has one (rounds
  // can repeat a path with unrelated line numbers).
  const rectIn = useCallback(
    (file: string, patchSeq: number | null | undefined, rowSel?: string) => {
      const root = scopeRef.current;
      const scope = patchSeq != null ? `[data-round="${patchSeq}"] ` : "";
      const base = `${scope}[data-file="${CSS.escape(file)}"]`;
      const el = rowSel ? root?.querySelector(`${base} ${rowSel}`) : root?.querySelector(base);
      return el?.getBoundingClientRect() ?? null;
    },
    [scopeRef],
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
      // Where a quote bubble would sit: centred over the first picked row.
      const r =
        rectIn(file, patchSeq, `[data-line="${lineStart}"][data-side="${side}"]`) ??
        rectIn(file, patchSeq, `[data-line="${lineStart}"]`);
      apply(
        { file, side, lineStart, lineEnd, quote, patchSeq },
        quote,
        r ? anchorRectFor(r, ROW_ANCHOR_WIDTH) : null,
      );
    },
    [apply, rectIn],
  );

  // The file header's feedback button: the composer anchors to the whole file (no
  // line span, no quote). `patchSeq` names the diff round the button lives in; the
  // server drops it to null when it doesn't name a stored round.
  const onFileFeedback = useCallback(
    (file: string, patchSeq?: number) => {
      const r = rectIn(file, patchSeq);
      setComposerAt(r ? anchorRectFor(r, FILE_ANCHOR_WIDTH, FILE_HEADER_HEIGHT) : null);
      setDraftAnchor(reviewId, {
        file,
        side: null,
        lineStart: null,
        lineEnd: null,
        quote: null,
        patchSeq,
      });
      onCompose();
    },
    [reviewId, rectIn, onCompose],
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

  // Drop just the anchored composer (its anchor + note), leaving any general note
  // or drafted reply on the review untouched. Both the deliberate Cancel/✕ discard
  // and a committed add settle the mobile sheet and clear the anchor the same way —
  // Cancel needs no confirm (Esc already preserves a non-empty note by only
  // blurring). Stable so the memoized FeedbackPanel isn't re-rendered on every
  // scroll-spy activePath change.
  const discard = useCallback(() => {
    onSettle();
    setComposerAt(null);
    dropAnchor(reviewId);
  }, [reviewId, onSettle]);

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
  }, [fileQuote, scopeRef]);

  // Anchor a draft to the file-view selection. Listen at document level: a drag
  // can end over the feedback panel, where the pane's mouseup never fires.
  // getSelectionAnchor is null unless the selection lands on a file line.
  useEffect(() => {
    if (coarse) return;
    const onMouseUp = () => {
      const root = scopeRef.current;
      if (!root) return;
      const a = getSelectionAnchor(root);
      if (!a) return;
      const sel = window.getSelection();
      const text = sel?.toString() ?? "";
      let rect: AnchorRect | null = null;
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0).getBoundingClientRect();
        rect = { left: r.left + r.width / 2, top: r.top, bottom: r.bottom };
      }
      apply(a, text, rect);
    };
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
  }, [apply, coarse, scopeRef]);

  // Leaving the review (remount on switch) drops a text-less anchor so an empty
  // composer doesn't linger/reopen; a draft with text (of any kind) stays persisted.
  useEffect(() => {
    return () => {
      const d = getDraft(reviewId);
      if (d && d.text.trim() === "") dropAnchor(reviewId);
    };
  }, [reviewId]);

  return {
    composerAt,
    fileQuote,
    apply,
    onPickLines,
    onFileFeedback,
    quoteIntoNote,
    discard,
  };
}
