// What an anchor gesture means, as pure rules — no React, no DOM, no stores, so
// the decision can be stated and tested on its own (the resolveFeedback.ts shape).
// useAnchorGesture.ts wires these to the draft store and the pane.

import type { PendingAnchor } from "./selection.ts";

// How wide a floating composer/bubble is allowed to assume its target is when
// centring itself over it. A file card spans the pane, so centring on the card's
// true middle would open the composer in the middle of the screen.
export const ROW_ANCHOR_WIDTH = 320;
export const FILE_ANCHOR_WIDTH = 360;
// A card is also most of the pane tall, and a composer hung off its bottom would
// open a screen away from the header button that opened it — so clip it to a
// header's worth of height.
export const FILE_HEADER_HEIGHT = 32;

// What an anchor gesture does, given the draft it lands on:
//   • no anchored composer open       -> open one here
//   • composer open, note still empty -> re-point it here
//   • composer open, note has text    -> never clobber the note; offer the
//     selection as a `>` blockquote instead ("quote"), or, with nothing to quote
//     and nowhere to put the bubble, do nothing at all.
// That last branch is the point of routing every producer (mouse selection,
// gutter drag, summary selection, touch pill) through one decision: selecting
// code in order to copy it used to silently re-point a half-written note.
export type AnchorAction =
  | { kind: "anchor" }
  | { kind: "quote"; pos: { left: number; top: number; text: string } }
  | { kind: "none" };

export function anchorGestureFor(
  draft: { anchor: PendingAnchor | null; text: string } | null,
  quoteText: string,
  rect: { left: number; top: number } | null,
): AnchorAction {
  const composing = draft?.anchor != null && (draft.text ?? "").trim() !== "";
  if (!composing) return { kind: "anchor" };
  if (rect && quoteText.trim())
    return { kind: "quote", pos: { left: rect.left, top: rect.top, text: quoteText } };
  return { kind: "none" };
}

// Where the transient UI hangs off a target box: horizontally centred, but over
// no more than `maxWidth` of it, and (for a tall target) clipped to `maxHeight`
// from its top.
export function anchorRectFor(
  r: { left: number; width: number; top: number; bottom: number },
  maxWidth: number,
  maxHeight?: number,
): { left: number; top: number; bottom: number } {
  return {
    left: r.left + Math.min(r.width, maxWidth) / 2,
    top: r.top,
    bottom: maxHeight == null ? r.bottom : Math.min(r.top + maxHeight, r.bottom),
  };
}
