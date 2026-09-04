// The anchor gesture's three-way branch, and where the transient UI it raises
// hangs. The branch is the one rule in this seam with real states behind it —
// "never clobber a note in progress" is the whole reason the gesture is routed
// rather than each producer setting the draft itself, and getting it wrong loses
// typed text silently. The rect math earns its test for the opposite reason: it
// is arithmetic whose only symptom, when wrong, is a composer opening somewhere
// unhelpful.

import { expect, test } from "bun:test";
import { anchorGestureFor, anchorRectFor } from "./anchorGesture.ts";
import type { PendingAnchor } from "./selection.ts";

const anchor: PendingAnchor = {
  file: "a.ts",
  side: null,
  lineStart: 1,
  lineEnd: 2,
  quote: "const a = 1;",
};
const rect = { left: 100, top: 40, bottom: 60 };

// ---- anchorGestureFor -------------------------------------------------------

test("no draft at all: the gesture opens a composer here", () => {
  expect(anchorGestureFor(null, "const a = 1;", rect)).toEqual({ kind: "anchor" });
});

test("a composer whose note is still empty is re-pointed, not left behind", () => {
  expect(anchorGestureFor({ anchor, text: "" }, "x", rect)).toEqual({ kind: "anchor" });
  // Whitespace isn't a note either.
  expect(anchorGestureFor({ anchor, text: "  \n " }, "x", rect)).toEqual({ kind: "anchor" });
});

test("typed text with no anchor is a general/reply draft — it doesn't block anchoring", () => {
  expect(anchorGestureFor({ anchor: null, text: "half a thought" }, "x", rect)).toEqual({
    kind: "anchor",
  });
});

test("a note in progress is never clobbered — the selection is offered as a quote", () => {
  expect(anchorGestureFor({ anchor, text: "half a thought" }, "const a = 1;", rect)).toEqual({
    kind: "quote",
    pos: { left: 100, top: 40, text: "const a = 1;" },
  });
});

test("a note in progress with nothing quotable does nothing at all", () => {
  // No rect to hang the bubble off (the touch pill's path)...
  expect(anchorGestureFor({ anchor, text: "note" }, "const a = 1;", null)).toEqual({
    kind: "none",
  });
  // ...or a blank selection (a gutter pick over empty lines).
  expect(anchorGestureFor({ anchor, text: "note" }, "   ", rect)).toEqual({ kind: "none" });
});

// ---- anchorRectFor ----------------------------------------------------------

test("a narrow target is centred on its own middle", () => {
  expect(anchorRectFor({ left: 10, width: 100, top: 5, bottom: 25 }, 320)).toEqual({
    left: 60,
    top: 5,
    bottom: 25,
  });
});

test("a target wider than the cap is centred on the cap, not on the pane", () => {
  // A file card spans the pane; centring on its true middle would open the
  // composer in the middle of the screen instead of near the gesture.
  expect(anchorRectFor({ left: 10, width: 1200, top: 5, bottom: 900 }, 320)).toEqual({
    left: 170,
    top: 5,
    bottom: 900,
  });
});

test("a maxHeight clips a tall card to its header, so the composer opens beside the button", () => {
  expect(anchorRectFor({ left: 0, width: 100, top: 200, bottom: 1400 }, 360, 32)).toEqual({
    left: 50,
    top: 200,
    bottom: 232,
  });
});

test("a target shorter than maxHeight keeps its own bottom", () => {
  expect(anchorRectFor({ left: 0, width: 100, top: 200, bottom: 210 }, 360, 32).bottom).toBe(210);
});
