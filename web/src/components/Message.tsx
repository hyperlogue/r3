// Rendered message prose (feedback bodies + replies) and the floating "quote this"
// bubble shared by the two selection-to-quote flows. Messages render as safe
// Markdown (markdown.ts); an `@path:Lx-y` ref inside one becomes a clickable jump
// anchor whose click is delegated here to onJumpRef.

import { type RefObject, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  // and re-parsing the whole thread's Markdown each time would be wasteful. The
  // memo must return the `{__html}` wrapper object itself, not just the string:
  // React 19 re-sets innerHTML on every commit whenever that object's identity
  // changes (a fresh inline literal never ===), wiping any text selection inside.
  const html = useMemo(() => ({ __html: renderMessageHtml(source) }), [source]);
  return (
    // renderMessageHtml runs markdown-it with html:false, so raw HTML in the
    // message is escaped, not injected — safe for dangerouslySetInnerHTML.
    // biome-ignore lint/a11y/useKeyWithClickEvents: the click only enhances rendered @ref anchors (themselves focusable links); plain prose needs no key handler
    <div
      className={cn("r3-markdown r3-msg", className)}
      onClick={onClick}
      dangerouslySetInnerHTML={html}
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

// One document mouseup for every live quote-bubble hook: first subscriber
// attaches, last detaches. Dispatch walks registered scopes (same per-card
// checks as before). Cards still call useQuoteBubble; they register here.
type QuoteSub = {
  scopeRef: RefObject<HTMLElement | null>;
  isEligible: (range: Range) => boolean;
  setPos: (pos: QuotePos | null) => void;
};

const quoteSubs = new Set<QuoteSub>();

function onQuoteMouseUp() {
  for (const sub of quoteSubs) {
    const scope = sub.scopeRef.current;
    if (!scope) continue; // scope-less consumer never had a bubble; dismissal is the second effect's job
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
      sub.setPos(null);
      continue;
    }
    const text = sel.toString();
    if (!text.trim()) {
      sub.setPos(null);
      continue;
    }
    const range = sel.getRangeAt(0);
    if (!scope.contains(range.startContainer) || !scope.contains(range.endContainer)) {
      sub.setPos(null);
      continue;
    }
    if (!sub.isEligible(range)) {
      sub.setPos(null);
      continue;
    }
    const r = range.getBoundingClientRect();
    sub.setPos({ left: r.left + r.width / 2, top: r.top, text });
  }
}

function retainQuoteSub(sub: QuoteSub): () => void {
  quoteSubs.add(sub);
  if (quoteSubs.size === 1) document.addEventListener("mouseup", onQuoteMouseUp);
  return () => {
    quoteSubs.delete(sub);
    if (quoteSubs.size === 0) document.removeEventListener("mouseup", onQuoteMouseUp);
  };
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
  const subRef = useRef<QuoteSub>({ scopeRef, isEligible, setPos });
  subRef.current.scopeRef = scopeRef;
  subRef.current.isEligible = isEligible;
  subRef.current.setPos = setPos;
  useEffect(() => retainQuoteSub(subRef.current), []);
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
