// Shared virtual-pane geometry. Artifact jumps live in useArtifactCodeJump.ts.
import { getFontSize } from "./settings.ts";

// Where the focused line sits after a scroll: 30% down the viewport, so there's
// reading context above it.
export const SCROLL_RATIO = 0.3;

// FileCard's sticky header overlays the top of the scroll pane, so a row in that
// band sits inside the pane's box but is visually covered. Its `h-8` is 2rem, and
// rem here is the ROOT font size — which is a user setting (settings.ts, 11–24px,
// default 18), not the 16px a literal 32 would assume. Read it from the same store
// that writes --r3-font-size rather than hard-coding one rem's worth of pixels: at
// the default the header is 36px, and at FONT_MAX it is 48.
const HEADER_REM = 2;

// The covered band at the pane's top edge: each file's sticky header, plus the
// mobile pane toolbar whose live height rides on the pane as --pane-sticky-h (0
// when unset — desktop, or no toolbar). Anything landing above this line is
// hidden under the chrome, so both the "is the anchor on screen?" test
// (highlights.ts) and a scroll asking to land at the pane top (virtual.tsx's
// align:"start") have to clear it. NOT the scroll-spy: it measures how much of a
// file the pane shows, and while a file is current the band holds that file's own
// header — which is a label, not lost reading height.
export function stickyBandPx(pane: HTMLElement): number {
  const toolbar =
    Number.parseFloat(getComputedStyle(pane).getPropertyValue("--pane-sticky-h")) || 0;
  return toolbar + getFontSize() * HEADER_REM;
}
