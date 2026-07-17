// A minimal pathname router (the app has two views: the reviews list at `/`
// (Home) and a review — see App.tsx). Avoids pulling in a routing framework + its
// codegen for an internal tool; deliberately small.

import { useSyncExternalStore } from "react";

// The daemon serves the SPA at the origin root, but the static frontend-only demo
// is hosted under a sub-path on GitHub Pages (e.g. https://…/r3/). BASE is that
// mount prefix WITHOUT a trailing slash ("" at root, "/r3" under a sub-path),
// injected at build time via __R3_BASE__ (scripts/build-demo.ts) and defaulting
// to root — so the daemon build is byte-for-byte unaffected. Routing is done in
// *app-relative* paths ("/", "/review_x"); hrefFor() maps them to real URLs and
// the store strips BASE back off, so deep links and middle-clicks resolve at
// whatever sub-path the app is mounted under.
declare const __R3_BASE__: string | undefined;
const BASE = (typeof __R3_BASE__ === "string" ? __R3_BASE__ : "/").replace(/\/+$/, "");

// Map an app-relative route to a real href under BASE (hrefFor("/") -> "/r3/").
export function hrefFor(route: string): string {
  return BASE + route;
}

// The current app-relative route: the live pathname with BASE stripped off.
function currentRoute(): string {
  const p = window.location.pathname;
  if (BASE && (p === BASE || p.startsWith(`${BASE}/`))) return p.slice(BASE.length) || "/";
  return p;
}

function subscribe(cb: () => void) {
  window.addEventListener("popstate", cb);
  window.addEventListener("r3-navigate", cb);
  return () => {
    window.removeEventListener("popstate", cb);
    window.removeEventListener("r3-navigate", cb);
  };
}

export function navigate(route: string) {
  const url = hrefFor(route);
  if (url !== window.location.pathname) {
    window.history.pushState({}, "", url);
    window.dispatchEvent(new Event("r3-navigate"));
  }
}

export function useRoute(): { path: string; reviewId: string | null } {
  const path = useSyncExternalStore(subscribe, currentRoute, () => "/");
  const m = path.match(/^\/(review_[\w]+)/);
  return { path, reviewId: m ? m[1] : null };
}
