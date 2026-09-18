import type { PreviewTheme } from "../../shared/preview-protocol.ts";
import type { ReadingPosition } from "./reading-position.ts";

// A display-only projection of hash-checked, server-rendered Markdown. Never
// parse publisher HTML here or insert this markup into the application DOM.
export function passiveMarkdownDocument(
  html: string,
  options: {
    nonce: string;
    applicationOrigin: string;
    theme: PreviewTheme;
    fitContent: boolean;
    position?: ReadingPosition;
  },
): string {
  const template = document.createElement("template");
  // Unlike DOMParser documents, template contents do not initiate resource loads.
  template.innerHTML = html;
  const tags = new Set(
    "main h1 h2 h3 h4 h5 h6 p a blockquote ol ul li pre code em strong del s br hr span div table thead tbody tfoot tr td th caption colgroup col style svg g defs marker path rect line polyline polygon circle ellipse text tspan title desc lineargradient radialgradient stop clippath".split(
      " ",
    ),
  );
  const attrs = new Set(
    "id class title lang dir colspan rowspan start reversed style viewbox xmlns width height x y x1 y1 x2 y2 cx cy r rx ry d points transform fill fill-opacity fill-rule stroke stroke-width stroke-linecap stroke-linejoin stroke-dasharray stroke-opacity opacity text-anchor dominant-baseline font-size font-family font-weight marker-end marker-start marker-mid markerwidth markerheight markerunits refx refy orient offset stop-color stop-opacity gradientunits gradienttransform clip-path preserveaspectratio".split(
      " ",
    ),
  );
  for (const element of template.content.querySelectorAll("*")) {
    if (!tags.has(element.localName.toLowerCase())) {
      if (element.localName === "img")
        element.replaceWith(document.createTextNode(element.getAttribute("alt") ?? ""));
      else element.remove();
      continue;
    }
    for (const attr of element.getAttributeNames()) {
      if (!attrs.has(attr.toLowerCase())) element.removeAttribute(attr);
    }
  }
  const main = template.content.querySelector("main");
  if (!main) throw new Error("Cached Markdown has no document body");
  const styles = [...template.content.querySelectorAll("style")]
    .map((style) => {
      const markup = style.outerHTML;
      style.remove();
      return markup;
    })
    .join("");
  const script = `(${installPassiveReading.toString()})(${JSON.stringify(options).replaceAll("<", "\\u003c")})`;
  // CSP is installed before any cached markup. No publisher script, navigable
  // URL, embedded document, form, resource attribute, or bridge operation remains.
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${options.nonce}'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'"><meta name="viewport" content="width=device-width,initial-scale=1">${styles}</head><body>${main.outerHTML}<script nonce="${options.nonce}">${script}</script></body></html>`;
}

// Only r3's layout/scroll helper executes. The document cannot request feedback,
// retrieve cached documents, or acquire an application/preview credential.
function installPassiveReading(options: {
  nonce: string;
  applicationOrigin: string;
  theme: PreviewTheme;
  fitContent: boolean;
  position?: ReadingPosition;
}) {
  for (const sheet of document.styleSheets) {
    for (const rule of sheet.cssRules) {
      if (
        rule instanceof CSSMediaRule &&
        /^\(prefers-color-scheme:\s*dark\)$/.test(rule.conditionText)
      )
        rule.media.mediaText = options.theme === "dark" ? "all" : "not all";
    }
  }
  document.documentElement.style.colorScheme = options.theme;
  document.documentElement.classList.toggle("dark", options.theme === "dark");
  document.body.style.backgroundColor = options.theme === "dark" ? "#0a0a0a" : "#ffffff";
  document.body.style.color = options.theme === "dark" ? "#f5f5f5" : "#171717";
  if (options.fitContent) document.documentElement.style.overflow = "hidden";
  else if (options.position) scrollTo(options.position.x, options.position.y);
  let frame = 0;
  const report = () => {
    frame = 0;
    parent.postMessage(
      {
        type: "r3-markdown-reading",
        nonce: options.nonce,
        height: Math.ceil(document.body.getBoundingClientRect().height),
        point: { x: scrollX, y: scrollY },
      },
      options.applicationOrigin,
    );
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(report);
  };
  new ResizeObserver(schedule).observe(document.body);
  window.addEventListener("scroll", schedule, { passive: true });
  report();
}
