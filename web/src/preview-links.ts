import { routeFor } from "./router.ts";

export type PreviewLinkAction = { kind: "route"; route: string } | { kind: "open"; href: string };

export function previewLinkAction(
  href: unknown,
  newTab: unknown,
  appOrigin: string,
): PreviewLinkAction | null {
  if (typeof href !== "string" || href.length > 8192) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (newTab !== true && url.origin === appOrigin) {
    const route = routeFor(url.pathname);
    if (route && /^\/(?:(?:artifact|review)_[\w-]+\/?)?$/.test(route))
      return { kind: "route", route: route + url.search + url.hash };
  }
  return { kind: "open", href: url.href };
}
