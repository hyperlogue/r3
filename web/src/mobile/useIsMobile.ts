import { useMediaQuery } from "./useMediaQuery.ts";

// The one JS-side mobile test, matching Tailwind's `max-md:` tier. Tailwind v4
// compiles max-md to `(width < 48rem)` (strictly-less, rem against the initial
// 16px — never the zoomed root font size), so the range syntax is the *exact*
// same predicate. Older engines (pre-2023) don't parse range queries —
// matchMedia then yields the never-matching "not all", so probe once and fall
// back to the classic form, off by at most 0.02px at the boundary. Everything
// width-driven should use `max-md:` classes; this hook exists only for the
// structural fork in ReviewView (which pane container to mount).
const RANGE = "(width < 48rem)";
const QUERY = window.matchMedia(RANGE).media !== "not all" ? RANGE : "(max-width: 767.98px)";

export function useIsMobile(): boolean {
  return useMediaQuery(QUERY);
}
