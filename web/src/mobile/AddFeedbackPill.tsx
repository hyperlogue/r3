import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { getSelectionAnchor, type PendingAnchor } from "../selection.ts";

// The touch-tier replacement for ReviewView's desktop `mouseup` selection-anchor
// listener (see AGENTS.md "Mobile" §C). iOS/Android never fire a usable `mouseup`
// for a long-press selection gesture, so on coarse pointers we watch
// `selectionchange` instead and float an "Add feedback" pill over the selection.
// ReviewView mounts this whenever the primary pointer is coarse — on BOTH tiers,
// since it's a fixed overlay — and skips its own mouseup path; desktop components
// never import from here.
//
// The tap routes through the same `applyAnchorGesture` as every other anchor
// gesture (via `onAdd`), so semantics never fork: an empty composer anchors a
// note, a composer already holding text quotes the selection in. The label tracks
// that split (`composing`) so it tells the truth about which will happen.

interface Capture {
  anchor: PendingAnchor;
  quote: string; // raw selection text — applyAnchorGesture's quoteText (matches the mouseup path)
  left: number; // selection-rect center, in viewport (fixed) coords
  top: number; // selection-rect top
}

// selectionchange fires continuously while an iOS selection handle is dragged;
// debounce so the pill settles once the drag pauses instead of flickering under
// the moving handles.
const SETTLE_MS = 275;

export function AddFeedbackPill({
  scopeRef,
  composing,
  onAdd,
}: {
  // The code scroll pane — the same element ReviewView scopes selections to.
  scopeRef: RefObject<HTMLElement | null>;
  // True when the anchored composer already holds text: applyAnchorGesture will
  // then drop the selection in as a quote rather than re-anchor, so the pill reads
  // "Quote in note" (the desktop QuoteBubble's wording) instead of "Add feedback".
  composing: boolean;
  onAdd: (anchor: PendingAnchor, quote: string) => void;
}) {
  // The anchor/quote/rect are captured here at selectionchange time and frozen —
  // iOS can collapse the selection the instant the pill is tapped, so the tap
  // handler reads this capture and never the live selection.
  const [cap, setCap] = useState<Capture | null>(null);

  // Measured half-width for the viewport clamp below. The label and the root
  // font size (user-scalable via --r3-font-size) both change the pill's width,
  // so measure the rendered button instead of hardcoding a pixel guess; 72 is
  // only the pre-measure estimate for the first paint.
  const btnRef = useRef<HTMLButtonElement>(null);
  const [halfWidth, setHalfWidth] = useState(72);
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the label or visibility flips
  useLayoutEffect(() => {
    if (cap && btnRef.current) setHalfWidth(btnRef.current.offsetWidth / 2 + 12);
  }, [cap != null, composing]);

  useEffect(() => {
    let timer = 0;
    const resolve = () => {
      const scope = scopeRef.current;
      const sel = window.getSelection();
      if (!scope || !sel || sel.isCollapsed || sel.rangeCount === 0) return setCap(null);
      // getSelectionAnchor returns null for a non-code / out-of-scope selection
      // (a summary or panel drag), so the pill stays down for those — summary
      // anchoring on touch is deliberately deferred.
      const anchor = getSelectionAnchor(scope);
      if (!anchor) return setCap(null);
      const r = sel.getRangeAt(0).getBoundingClientRect();
      setCap({ anchor, quote: sel.toString(), left: r.left + r.width / 2, top: r.top });
    };
    const onSelChange = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(resolve, SETTLE_MS);
    };
    // Any scroll slides the code out from under the frozen rect — dismiss rather
    // than point the pill at the wrong line (the selection itself survives).
    // Captured on document because scroll events don't bubble and the pane
    // (scopeRef) only scrolls vertically — long lines scroll horizontally on a
    // per-file inner container, which the capture phase still reaches.
    const onScroll = () => setCap(null);
    document.addEventListener("selectionchange", onSelChange);
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", onSelChange);
      document.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [scopeRef]);

  if (!cap) return null;
  // Same bubble family as Message.tsx's QuoteBubble (fixed, centered above the
  // selection). select-none + the mousedown preventDefault keep the tap from
  // perturbing the selection where they can; the frozen capture is the fallback
  // when iOS collapses it anyway.
  //
  // Clamp the center into the viewport: a long code line in the horizontal
  // scroll pane yields a selection rect wider than the screen, whose center —
  // and so the pill — would land past the edge (and a fixed box positioned
  // off-viewport shrinks and wraps its label). whitespace-nowrap guards the
  // wrap; halfWidth is the measured half-pill plus a margin.
  const left = Math.min(Math.max(cap.left, halfWidth), window.innerWidth - halfWidth);
  return (
    <button
      ref={btnRef}
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        onAdd(cap.anchor, cap.quote);
        setCap(null); // one-shot: the next selection re-raises it
      }}
      className="fixed z-50 -translate-x-1/2 -translate-y-full touch-manipulation select-none whitespace-nowrap rounded-md bg-neutral-800 px-3 py-1.5 text-xs font-medium text-white shadow-lg ring-1 ring-black/10 dark:bg-neutral-700"
      style={{ left, top: cap.top - 6 }}
    >
      {composing ? "Quote in note" : "Add feedback"}
    </button>
  );
}
