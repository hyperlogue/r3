import { type Locale, languageTags, localePath } from "./i18n.ts";

export async function localizeHTML(html: string, locale: Locale): Promise<string> {
  return new HTMLRewriter()
    .on("*", {
      element(element) {
        if (element.tagName === "html") element.setAttribute("lang", languageTags[locale]);
        if (!element.hasAttribute("data-locale")) {
          for (const attr of ["href", "data-markdown", "action"]) {
            const path = element.getAttribute(attr);
            if (path) element.setAttribute(attr, localePath(path, locale));
          }
        }
        if (element.tagName === "a" && locale !== "en") {
          const href = element.getAttribute("href");
          if (href && /^\/(?:example|demo)\//.test(href))
            element.setAttribute("href", `${href}${href.includes("?") ? "&" : "?"}lang=${locale}`);
        }
      },
    })
    .transform(new Response(html))
    .text();
}
