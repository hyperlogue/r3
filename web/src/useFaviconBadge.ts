import { useEffect } from "react";
import logoUrl from "../favicon.svg";

let badgedMark: Promise<string> | undefined;
function notificationIcon(): Promise<string> {
  badgedMark ??= fetch(logoUrl)
    .then((response) => {
      if (!response.ok) throw new Error("Unable to load the tab icon");
      return response.text();
    })
    .then((svg) => {
      const badge =
        '<circle cx="82" cy="82" r="16" fill="#2563eb" stroke="white" stroke-width="4"/>';
      return `data:image/svg+xml,${encodeURIComponent(svg.replace(/<\/svg>\s*$/, `${badge}</svg>`))}`;
    })
    .catch((error) => {
      badgedMark = undefined;
      throw error;
    });
  return badgedMark;
}

// Tab attention follows the current artifact, including while the tab is visible.
// Cleanup also prevents a late asset fetch from badging a different page.
export function useFaviconBadge(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    const original = link.href;
    let cancelled = false;
    let applied: string | undefined;
    void notificationIcon().then(
      (href) => {
        if (cancelled) return;
        applied = href;
        link.href = href;
      },
      () => {}, // Keep the ordinary icon if its asset cannot be loaded.
    );
    return () => {
      cancelled = true;
      if (applied && link.href === applied) link.href = original;
    };
  }, [active]);
}
