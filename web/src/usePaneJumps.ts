// Pane jumps share one nonce-gated unfold/hydrate + retrying scroll so a
// newer locate/pin/ref/file-select invalidates every older callback/frame.

import { type Dispatch, type RefObject, type SetStateAction, useCallback, useRef } from "react";
import type { FoldSignal } from "./components/FileCard.tsx";
import type { DocLink } from "./doclinks.ts";
import type { MessageRef } from "./markdown.ts";
import { retryScrollToRow } from "./pane.ts";
import type { useProgressiveFileController } from "./progressive.tsx";
import type { FeedbackWithReplies } from "./types.ts";
import { SUMMARY_FILE } from "./types.ts";
import type { ReviewVersion } from "./useReviewVersion.ts";
import { fileScrollKey, type ScrollToLine } from "./virtual.tsx";

/** What a jump does to the content pane once it knows where it is going. */
export interface PaneControls {
  /** Unfold the target file (path-scoped, nonce-gated) before scrolling to it. */
  setFoldSignal: Dispatch<SetStateAction<FoldSignal | null>>;
  /** The scroll-spy's cursor, which a jump sets directly at its destination. */
  setActivePath: Dispatch<SetStateAction<string | null>>;
  /** Mobile: a jump landing in the code pane closes the sheet over it. */
  closeSheet: () => void;
}

/** The feedback cursor a locate moves, and the nonce that re-fires its scroll. */
export interface FeedbackFocus {
  setActiveFbId: Dispatch<SetStateAction<string | null>>;
  setScrollNonce: Dispatch<SetStateAction<number>>;
}

export function usePaneJumps({
  scopeRef,
  scrollToLine,
  progressive,
  version,
  pane,
  focus,
  hasFile,
}: {
  scopeRef: RefObject<HTMLElement | null>;
  scrollToLine: ScrollToLine;
  progressive: ReturnType<typeof useProgressiveFileController>;
  /** Which round/snapshot is on screen — a jump may have to switch it first. */
  version: ReviewVersion;
  pane: PaneControls;
  focus: FeedbackFocus;
  hasFile: (path: string) => boolean;
}) {
  const { isDiff, effectiveRoundSeq, snapshots, fromSnap, toSnap } = version;
  const { setActiveRoundSeq, setFromSnap, setToSnap } = version;
  const { setFoldSignal, setActivePath, closeSheet: closeSheetForJump } = pane;
  const { setActiveFbId, setScrollNonce } = focus;
  const fileSelectNonce = useRef(0);
  const scrollAnim = useRef(0);
  // In-flight toolbar scroll: the spy must not overwrite the activePath a jump
  // just set (rapid next/next steps from the *target*, not the mid-flight frame).
  const scrollAnimating = useRef(false);

  const ensureFileOpen = useCallback(
    (path: string, onHydrated?: () => void) => {
      setFoldSignal((s) => ({ mode: "unfold", nonce: (s?.nonce ?? 0) + 1, path }));
      if (progressive.activate(path, onHydrated)) return;
      if (!onHydrated) return;
      // A review under the size gate registers no shells at all. A round or
      // snapshot switch remounts them on the next commit, so retry a few frames
      // before running the jump anyway — the old DOM-retry budget cannot wait
      // out a blob fetch. (A shell that IS reached and then unmounts under the
      // switch hands its waiter back rather than dropping it — progressive.tsx.)
      let tries = 0;
      const retry = () => {
        if (progressive.activate(path, onHydrated)) return;
        if (progressive.registry.current.size === 0 || ++tries >= 30) onHydrated();
        else requestAnimationFrame(retry);
      };
      requestAnimationFrame(retry);
    },
    [progressive.activate, progressive.registry, setFoldSignal],
  );

  const scrollToFile = useCallback(
    (path: string, opts?: { animate?: boolean }) => {
      const root = scopeRef.current;
      if (!root) return;
      const el = root.querySelector(`[data-file="${CSS.escape(path)}"]`);
      if (!el) return;
      cancelAnimationFrame(scrollAnim.current);
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
          // Leave scrollAnimating set — selectFile's post-hydrate settle owns
          // clearing it, so the spy can't steal activePath while the deferred
          // body is still growing.
        };
        scrollAnim.current = requestAnimationFrame(step);
      } else {
        // File-browser click: instant jump — an animation through an arbitrary
        // distance of highlighted code reads as lag. Set scrollTop directly
        // (block:"start" of the target relative to the scroll container).
        root.scrollTop += el.getBoundingClientRect().top - root.getBoundingClientRect().top;
      }
      setActivePath(path);
    },
    [scopeRef, setActivePath],
  );

  // Picking a file from the browser tree or the jump-to-file picker: unfold it,
  // then scroll to it. Clicking a file in the list is a "show me this" gesture,
  // so a viewed (auto-folded) file you click is one you want to read again —
  // open it rather than leaving it collapsed under its header.
  const selectFile = useCallback(
    (path: string, opts?: { animate?: boolean }) => {
      const nonce = ++fileSelectNonce.current;
      // Jump immediately against the stable shell, then once more after a
      // deferred body commits. Nearby preload shells may finish in the same
      // beat and shift the stack, so re-pin for a short post-hydration window;
      // a newer selection invalidates every older callback/frame. Hold the spy
      // until that settle ends so `]`/`[` can't land on a still-growing block.
      cancelAnimationFrame(scrollAnim.current);
      scrollAnimating.current = true;
      ensureFileOpen(path, () => {
        if (fileSelectNonce.current !== nonce) return;
        let frame = 0;
        const settle = () => {
          if (fileSelectNonce.current !== nonce) return;
          scrollToFile(path);
          if (++frame < 18) scrollAnim.current = requestAnimationFrame(settle);
          else scrollAnimating.current = false;
        };
        settle();
      });
      scrollToFile(path, opts);
    },
    [ensureFileOpen, scrollToFile],
  );

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
      closeSheetForJump();
      // Anchored to a specific round → select its tab first so that round's DOM is
      // mounted before the highlight effect (keyed on scrollNonce) queries + scrolls
      // to it; both state updates batch into one render, effects run after commit.
      if (fb.patch_seq != null) setActiveRoundSeq(fb.patch_seq);
      // A folded / deferred target has no mounted rows to scroll to — open and
      // hydrate it first, then bump the nonce so the highlight effect retries
      // against the real body rather than the shell's ~1s DOM budget.
      if (fb.file && fb.file !== SUMMARY_FILE) {
        const nonce = ++fileSelectNonce.current;
        cancelAnimationFrame(scrollAnim.current);
        scrollAnimating.current = false;
        ensureFileOpen(fb.file, () => {
          if (fileSelectNonce.current !== nonce) return;
          setScrollNonce((n) => n + 1);
        });
      } else {
        setScrollNonce((n) => n + 1);
      }
      setActiveFbId(fb.id);
    },
    [ensureFileOpen, closeSheetForJump, setActiveFbId, setActiveRoundSeq, setScrollNonce],
  );

  // Jump to a reply pin ("addressed in diff N"): scroll the pinned row into
  // view, preferring the new side — pins point at the fix, not the old code.
  const locatePin = useCallback(
    (patchSeq: number, file: string | null, line: number | null) => {
      closeSheetForJump();
      // The pin usually names a different round than the one on screen — select
      // its tab, and open the pinned file if it's folded, then scroll to the
      // row (retryScrollToRow waits out the round tab + unfold mounting).
      setActiveRoundSeq(patchSeq);
      const roundSel = `[data-round="${patchSeq}"]`;
      const jump = () =>
        retryScrollToRow({
          getRoot: () => scopeRef.current,
          scrollToLine,
          scrollKey: file != null && line != null ? fileScrollKey(patchSeq, file) : null,
          containerSel: file ? `${roundSel} [data-file="${CSS.escape(file)}"]` : roundSel,
          line,
          side: "new",
        });
      if (file) {
        const nonce = ++fileSelectNonce.current;
        cancelAnimationFrame(scrollAnim.current);
        scrollAnimating.current = false;
        ensureFileOpen(file, () => {
          if (fileSelectNonce.current !== nonce) return;
          jump();
        });
      } else jump();
    },
    [scrollToLine, ensureFileOpen, closeSheetForJump, scopeRef, setActiveRoundSeq],
  );

  // Jump the pane to an `@path:Lx-y` ref clicked inside a rendered message,
  // resolved against the message's pinned `version` (a reply's ref_version, or a
  // feedback body's round). A diff review reuses the immutable round pin jump; a
  // files review whose ref names a content snapshot switches the pane to a plain
  // view of that snapshot first (its line numbers are what the ref was written
  // against), else scrolls the live file.
  const jumpToRef = useCallback(
    (ref: MessageRef, version: number | null) => {
      closeSheetForJump();
      if (isDiff) {
        locatePin(version ?? effectiveRoundSeq ?? 0, ref.file, ref.lineStart);
        return;
      }
      // A snapshot-pinned ref: show that snapshot plainly so the line lands right —
      // but only if we're not already viewing it. "Current" (WORKING) continues the
      // newest capture, so a ref pinned to the latest snapshot is already on screen
      // while we're on Current; switching to `v<latest>` there would needlessly yank
      // the pane off the live view for no visible change.
      if (version != null && snapshots.some((s) => s.seq === version)) {
        const latestSeq = Math.max(...snapshots.map((s) => s.seq));
        const alreadyShown =
          fromSnap === null &&
          (toSnap === version || (toSnap === "WORKING" && version === latestSeq));
        if (!alreadyShown) {
          setFromSnap(null);
          setToSnap(version);
        }
      } else if (fromSnap != null || toSnap !== "WORKING") {
        // No snapshot on the ref — force live so the jump's `:path` isn't DiffView's `0:path`.
        setFromSnap(null);
        setToSnap("WORKING");
      }
      const nonce = ++fileSelectNonce.current;
      cancelAnimationFrame(scrollAnim.current);
      scrollAnimating.current = false;
      ensureFileOpen(ref.file, () => {
        if (fileSelectNonce.current !== nonce) return;
        retryScrollToRow({
          getRoot: () => scopeRef.current,
          scrollToLine,
          scrollKey: fileScrollKey(null, ref.file),
          containerSel: `[data-file="${CSS.escape(ref.file)}"]`,
          line: ref.lineStart,
          side: null,
        });
      });
    },
    [
      isDiff,
      locatePin,
      effectiveRoundSeq,
      snapshots,
      fromSnap,
      toSnap,
      setFromSnap,
      setToSnap,
      ensureFileOpen,
      scrollToLine,
      closeSheetForJump,
      scopeRef,
    ],
  );

  // Click a relative link inside a rendered `.md` and land on that file in this
  // pane. A heading hash scrolls to it (scoped to the target card); otherwise
  // it's the same jump the file browser does. A target outside the review
  // renders dead (doclinks.ts) and this ignores it.
  const openDocLink = useCallback(
    (link: DocLink) => {
      if (!hasFile(link.file)) return;
      closeSheetForJump();
      if (!link.hash) {
        selectFile(link.file);
        return;
      }
      const hash = link.hash;
      const nonce = ++fileSelectNonce.current;
      cancelAnimationFrame(scrollAnim.current);
      scrollAnimating.current = false;
      ensureFileOpen(link.file, () => {
        if (fileSelectNonce.current !== nonce) return;
        retryScrollToRow({
          getRoot: () => scopeRef.current,
          scrollToLine,
          scrollKey: null,
          containerSel: `[data-file="${CSS.escape(link.file)}"]`,
          rowSel: `[data-r3-heading="${CSS.escape(hash)}"]`,
          line: null,
          side: null,
        });
      });
    },
    [hasFile, selectFile, ensureFileOpen, scrollToLine, closeSheetForJump, scopeRef],
  );

  return {
    locateFeedback,
    locatePin,
    jumpToRef,
    openDocLink,
    selectFile,
    scrollAnimating,
  };
}
