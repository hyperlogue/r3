import type { ArtifactPreviewNetwork } from "../../shared/artifacts.ts";
import { routeFor } from "./router.ts";

export type PreviewLinkAction =
  | { kind: "route"; route: string }
  | { kind: "open"; href: string; confirm: boolean };

// A link URL can carry anything the page read, so leaving the app origin needs
// confirmation unless the reader already granted this preview external network.
export function previewLinkAction(
  href: unknown,
  newTab: unknown,
  appOrigin: string,
  network: ArtifactPreviewNetwork,
): PreviewLinkAction | null {
  if (typeof href !== "string" || href.length > 8192) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const sameOrigin = url.origin === appOrigin;
  if (newTab !== true && sameOrigin) {
    const route = routeFor(url.pathname);
    if (route && /^\/(?:(?:artifact|review)_[\w-]+\/?)?$/.test(route))
      return { kind: "route", route: route + url.search + url.hash };
  }
  return { kind: "open", href: url.href, confirm: !sameOrigin && network !== "external" };
}
