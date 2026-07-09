// A minimal pathname router (the app has two views: the reviews list at `/`
// (Home) and a review — see App.tsx). Avoids pulling in a routing framework + its
// codegen for an internal tool; deliberately small.

import { useSyncExternalStore } from "react";

function subscribe(cb: () => void) {
  window.addEventListener("popstate", cb);
  window.addEventListener("r3-navigate", cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener("r3-navigate", cb);
  };
}

export function navigate(path: string) {
  if (path !== window.location.pathname) {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new Event("r3-navigate"));
  }
}

export function useRoute(): { path: string; reviewId: string | null } {
  const path = useSyncExternalStore(
    subscribe,
    () => window.location.pathname,
    () => "/",
  );
  const m = path.match(/^\/(review_[\w]+)/);
  return { path, reviewId: m ? m[1] : null };
}
