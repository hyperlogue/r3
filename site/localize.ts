import MarkdownIt from "markdown-it";
import { type Locale, languageTags, localePath, t } from "./i18n.ts";

const md = new MarkdownIt();
const textAttributes = ["alt", "title", "aria-label", "placeholder"];
// Localize the authored static shell and landing pages at build time. Article
// prose has its own Markdown source. Code, URLs, scripts and examples stay literal.
export async function localizeHTML(
  html: string,
  locale: Locale,
  messages?: Set<string>,
): Promise<string> {
  let skipped = 0;
  let text = "";
  const localize = (value: string) => {
    const key = md.utils.unescapeAll(value).replace(/\s+/g, " ").trim();
    if (!key || !/[a-zA-Z]/.test(key)) return value;
    messages?.add(key);
    const translated = t(key, undefined, locale);
    return translated === key ? value : value.replace(/\S[\s\S]*\S|\S/, translated);
  };
  return new HTMLRewriter()
    .on("*", {
      element(element) {
        if (element.hasAttribute("data-visual-i18n") && skipped) {
          skipped--;
          element.onEndTag(() => {
            skipped++;
          });
        }
        const skip =
          ["script", "style", "pre", "code"].includes(element.tagName) ||
          element.hasAttribute("data-no-i18n") ||
          element.hasAttribute("data-locale") ||
          element.getAttribute("class")?.split(/\s+/).includes("prose");
        if (skip) {
          skipped++;
          element.onEndTag(() => {
            skipped--;
          });
        }
        if (!skipped) {
          for (const attr of textAttributes) {
            const value = element.getAttribute(attr);
            if (value) element.setAttribute(attr, localize(value));
          }
          if (
            element.tagName === "meta" &&
            ["description", "og:title", "og:description"].includes(
              element.getAttribute("name") ?? element.getAttribute("property") ?? "",
            )
          ) {
            element.setAttribute("content", localize(element.getAttribute("content") ?? ""));
          }
        }
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
    .onDocument({
      text(chunk) {
        if (skipped) return;
        text += chunk.text;
        chunk.remove();
        if (chunk.lastInTextNode) {
          // Translation values are text, never executable HTML.
          const value = localize(text);
          chunk.replace(value, { html: value === text });
          text = "";
        }
      },
    })
    .transform(new Response(html))
    .text();
}
