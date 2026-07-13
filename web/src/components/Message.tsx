// Rendered message prose (feedback bodies + replies) and the floating "quote this"
// bubble shared by the two selection-to-quote flows. Messages render as safe
// Markdown (markdown.ts); an `@path:Lx-y` ref inside one becomes a clickable jump
// anchor whose click is delegated here to onJumpRef.

import { type RefObject, useCallback, useEffect, useMemo, useState } from "react";
import { type MessageRef, refFromEvent, renderMessageHtml } from "../markdown.ts";
import { cn, scrollParent } from "../ui.tsx";

// Render `source` as compact Markdown. `.r3-markdown` carries the prose styling
// (shared with file `.md` rendering); `.r3-msg` trims the outer block margins for
// the tight card context. A delegated click on an `@ref` anchor jumps the pane.
export function MessageProse({
  source,
  className,
  onJumpRef,
}: {
  source: string;
  className?: string;
  // Bound by the caller with the message's version context before it reaches
  // ReviewView's jump (a diff review resolves the ref against a round/snapshot).
  onJumpRef?: (ref: MessageRef) => void;
}) {
  const onClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const ref = refFromEvent(e.target);
      if (!ref) return; // a normal external link (target=_blank) falls through
      e.preventDefault();
      onJumpRef?.(ref);
    },
    [onJumpRef],
  );
  // Parse once per distinct source — a card re-renders on every reply keystroke,
  // and re-parsing the whole thread's Markdown each time would be wasteful.
  const html = useMemo(() => renderMessageHtml(source), [source]);
  return (
    // renderMessageHtml runs markdown-it with html:false, so raw HTML in the
    // message is escaped, not injected — safe for dangerouslySetInnerHTML.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click only enhances rendered @ref anchors (themselves focusable links); plain prose needs no key handler
    <div
      className={cn("r3-markdown r3-msg", className)}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export interface QuotePos {
  left: number;
  top: number;
  text: string;
}

// The floating "quote this selection" button, positioned (fixed) above the
// selection. onMouseDown preventDefault keeps the selection alive through the
// click so we can still read it; onClick then hands the text to the caller.
export function QuoteBubble({
  pos,
  label,
  onQuote,
}: {
  pos: QuotePos;
  label: string;
  onQuote: (text: string) => void;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onQuote(pos.text)}
      className="fixed z-50 -translate-x-1/2 -translate-y-full rounded-md bg-neutral-800 px-2 py-1 text-[0.6875rem] font-medium text-white shadow-lg ring-1 ring-black/10 hover:bg-neutral-700 dark:bg-neutral-700 dark:hover:bg-neutral-600"
      style={{ left: pos.left, top: pos.top - 6 }}
    >
      {label}
    </button>
  );
}

// Watch for a text selection inside `scopeRef` that `isEligible` accepts, and
// track a bubble position for it. Hides on collapse, on scroll (the fixed
// position goes stale), and when the caller calls `hide()` (after quoting).
export function useQuoteBubble(
  scopeRef: RefObject<HTMLElement | null>,
  isEligible: (range: Range) => boolean,
): { pos: QuotePos | null; hide: () => void } {
  const [pos, setPos] = useState<QuotePos | null>(null);
  const hide = useCallback(() => setPos(null), []);
  useEffect(() => {
    // Consumers may mount their scope element *after* this hook first runs (e.g.
    // ReviewSummary renders null until a summary arrives over SSE), so the listener
    // lives on `document` and reads the live `scopeRef.current` per event rather than
    // capturing the element at effect time — otherwise a scope that appears later
    // never gets a listener. mouseup is a discrete event, so N cards each paying a
    // cheap no-op check per click is fine (unlike selectionchange, which is why the
    // second effect below still attaches only while a bubble is up).
    const onMouseUp = () => {
      const scope = scopeRef.current;
      if (!scope) return; // scope-less consumer never had a bubble; dismissal is the second effect's job
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return setPos(null);
      const text = sel.toString();
      if (!text.trim()) return setPos(null);
      const range = sel.getRangeAt(0);
      if (!scope.contains(range.startContainer) || !scope.contains(range.endContainer))
        return setPos(null);
      if (!isEligible(range)) return setPos(null);
      const r = range.getBoundingClientRect();
      setPos({ left: r.left + r.width / 2, top: r.top, text });
    };
    document.addEventListener("mouseup", onMouseUp);
    return () => document.removeEventListener("mouseup", onMouseUp);
  }, [scopeRef, isEligible]);
  // The global dismiss listeners attach only while a bubble is up: every feedback
  // card runs this hook, so idle cards must cost zero document/scroll listeners
  // (N cards would otherwise each re-check the selection on every caret move).
  useEffect(() => {
    if (!pos) return;
    const onSelChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) setPos(null);
    };
    const sp = scopeRef.current ? scrollParent(scopeRef.current) : null;
    const onScroll = () => setPos(null);
    document.addEventListener("selectionchange", onSelChange);
    sp?.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      document.removeEventListener("selectionchange", onSelChange);
      sp?.removeEventListener("scroll", onScroll);
    };
  }, [pos, scopeRef]);
  return { pos, hide };
}

// Wrap `text` as a Markdown blockquote for the reply/note composer: each line
// gets a "> " prefix, separated from any existing text by a blank line, with a
// trailing blank line so the caret lands *outside* the quote ready to type. The
// returned caret offset is the end of the produced string.
export function quoteBlock(existing: string, quoted: string): { text: string; caret: number } {
  const q = quoted
    .replace(/\s+$/, "")
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  const lead = existing.trim() === "" ? "" : `${existing.replace(/\n+$/, "")}\n\n`;
  const text = `${lead}${q}\n\n`;
  return { text, caret: text.length };
}
