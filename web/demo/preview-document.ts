import type { ArtifactVersion } from "../../shared/artifacts.ts";
import { normalizeRenderedText } from "../../shared/rendered-text.ts";
import { installMarkdownLayout, installMarkdownTheme } from "../src/preview-markdown.ts";
import { installPreviewRuntime } from "../src/preview-runtime.ts";
import { composerKeyAction, observeTextSelection } from "../src/selection-events.ts";
import { bundledPreview, demoReference } from "./preview-fixtures.ts";
import { connectDemoPreview } from "./preview-runtime.ts";

export function prepareDemoDocument(
  version: ArtifactVersion,
  path: string,
  contextId: string,
  applicationOrigin: string,
  route: string,
) {
  const bundled = bundledPreview(version, path);
  if (!bundled)
    throw new Error(
      "This preview is unavailable. The static demo renders only its bundled examples.",
    );
  const document = new DOMParser().parseFromString(bundled.html, "text/html");
  const asset = (reference: string) => {
    const resolved = demoReference(path, reference);
    return resolved && bundled.publication.files.find((file) => file.path === resolved.path);
  };
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')) {
    const file = asset(link.getAttribute("href") ?? "");
    if (!file || file.mediaType !== "text/css") throw new Error("Unbundled demo stylesheet");
    const style = document.createElement("style");
    style.textContent = new TextDecoder().decode(
      Uint8Array.from(atob(bundled.publication.resources[file.path]), (c) => c.charCodeAt(0)),
    );
    link.replaceWith(style);
  }
  for (const image of document.querySelectorAll<HTMLImageElement>("img[src]")) {
    const file = asset(image.getAttribute("src") ?? "");
    image.removeAttribute("srcset");
    if (file && /^image\/(?:svg\+xml|png|jpeg|gif|webp)$/.test(file.mediaType))
      image.src = `data:${file.mediaType};base64,${bundled.publication.resources[file.path]}`;
    else image.removeAttribute("src");
  }
  for (const link of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const reference = demoReference(path, link.getAttribute("href") ?? "");
    link.removeAttribute("target");
    if (reference && Object.hasOwn(bundled.documents, reference.path)) {
      link.href = "#";
      link.dataset.demoPath = reference.path;
      link.dataset.demoRoute = reference.route;
    } else {
      link.removeAttribute("href");
      link.setAttribute("aria-disabled", "true");
      link.title = "Only bundled document links work in this demo";
    }
  }
  const config = JSON.stringify({
    contextId,
    applicationOrigin,
    artifactId: version.artifactId,
    versionSeq: version.seq,
    entryPath: path,
    resourceRoot: "",
    presentation: "document",
    route,
  }).replaceAll("<", "\\u003c");
  const script = document.createElement("script");
  const markdown = !!bundled.publication.files.find((file) => file.path === path)?.renderedHash;
  if (markdown) script.setAttribute("data-r3-markdown", "");
  script.textContent = `(() => { const config = ${config};
const connection = (${connectDemoPreview.toString()})(config);
(${installMarkdownTheme.toString()})(config, connection);
(${installMarkdownLayout.toString()})(config, connection);
(${installPreviewRuntime.toString()})(config, ${normalizeRenderedText.toString()}, connection, ${observeTextSelection.toString()}, ${composerKeyAction.toString()}); })();`.replace(
    /<\/script/gi,
    "<\\/script",
  );
  const policy = document.createElement("meta");
  policy.httpEquiv = "Content-Security-Policy";
  // CSP is a resource restriction, not a proof of total network isolation.
  // No network URLs are needed: scripts/styles are inline, images are data URLs.
  policy.content =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  document.head.prepend(policy, script);
  return { html: `<!doctype html>${document.documentElement.outerHTML}`, markdown };
}
