import { useSyncExternalStore } from "react";

// The one JS-side mobile test, matching Tailwind's `max-md:` tier (md = 48rem;
// media-query rems resolve against the initial 16px, never the zoomed root font
// size, so this is 768px regardless of the UI-zoom setting). Everything
// width-driven should use `max-md:` classes; this hook exists only for the
// structural fork in ReviewView (which pane container to mount).
const QUERY = "(max-width: 767.98px)";

function subscribe(onChange: () => void): () => void {
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, () => window.matchMedia(QUERY).matches);
}
