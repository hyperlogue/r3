import { useMediaQuery } from "./useMediaQuery.ts";

// The gesture-affordance test (see AGENTS.md "Mobile"): keys on the *primary*
// pointer being coarse, NOT the viewport-width tier `useIsMobile` reads. The two
// diverge on purpose — a narrow desktop window (fine pointer below md) must keep
// the instant mouseup→anchor path, and a portrait tablet (coarse pointer, desktop
// layout) must still get touch anchoring. So layout forks on `useIsMobile`; every
// touch-anchor affordance (the AddFeedbackPill, the mouseup-listener skip) gates
// on this. No fallback probe like useIsMobile's: `(pointer: coarse)` is a plain
// feature query with no old/new syntax split.
export function usePointerCoarse(): boolean {
  return useMediaQuery("(pointer: coarse)");
}
