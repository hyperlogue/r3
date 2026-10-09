import MarkdownIt from "markdown-it";
import { createHighlighter } from "shiki";

export function escapeHTML(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function normalizeBase(value = "") {
  if (value && !/^\/[a-zA-Z0-9/_-]*$/.test(value))
    throw new Error("R3_SITE_BASE must be a URL path");
  const path = value.split("/").filter(Boolean).join("/");
  return path ? `/${path}` : "";
}

export function publicURL(base: string, value?: string) {
  const url = new URL(value || `https://example.test${base}`);
  if (
    !/^https?:$/.test(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname.replace(/\/$/, "") !== base
  ) {
    throw new Error("R3_SITE_URL must be an HTTP(S) public URL matching R3_SITE_BASE");
  }
  return url.href.replace(/\/$/, "");
}

export type Heading = { id: string; text: string };
export async function createRenderer() {
  const highlighter = await createHighlighter({
    themes: ["github-light", "github-dark"],
    langs: ["bash", "html", "typescript", "json", "diff", "markdown"],
  });
  const md = new MarkdownIt({
    html: true,
    linkify: false,
    typographer: true,
    highlight(code: string, language: string) {
      const aliases: Record<string, string> = { sh: "bash", ts: "typescript", md: "markdown" };
      const lang = aliases[language] || language;
      if (!highlighter.getLoadedLanguages().includes(lang))
        return `<pre><code>${escapeHTML(code)}</code></pre>`;
      return highlighter.codeToHtml(code, {
        lang,
        themes: { light: "github-light", dark: "github-dark" },
        defaultColor: false,
      });
    },
  });
  return {
    render(source: string) {
      const headings: Heading[] = [];
      const used = new Map<string, number>();
      const tokens = md.parse(source, {});
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].type !== "heading_open") continue;
        const text = tokens[i + 1].content;
        const slug =
          text
            .toLowerCase()
            .replace(/[`*]/g, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "") || "section";
        const count = used.get(slug) || 0;
        used.set(slug, count + 1);
        const id = count ? `${slug}-${count + 1}` : slug;
        tokens[i].attrSet("id", id);
        if (tokens[i].tag === "h2") headings.push({ id, text: text.replace(/[`*]/g, "") });
      }
      return { html: md.renderer.render(tokens, md.options, {}), headings };
    },
    dispose: () => highlighter.dispose(),
  };
}

// Site authors may mix HTML layout into Markdown. Exports keep the authored
// prose, code, links, and captions while dropping these presentational wrappers.
export function markdownExport(source: string, origin: string) {
  const tokens = new MarkdownIt({ html: true }).parse(source, {});
  const lines = source.split("\n");
  const blocks = new Map<number, { end: number; type: string }>();
  for (const token of tokens) {
    if (token.map && ["fence", "code_block", "html_block"].includes(token.type)) {
      blocks.set(token.map[0], { end: token.map[1], type: token.type });
    }
  }
  const output: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const block = blocks.get(i);
    if (block) {
      let text = lines.slice(i, block.end).join("\n");
      if (block.type === "html_block") {
        text = text
          .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "")
          .replace(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, "[$2]($1)")
          .replace(/<\/?(?:strong|b)>/gi, "**")
          .replace(/<\/?(?:em|i)>/gi, "*")
          .replace(
            /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
            (_, level, content) => `\n\n${"#".repeat(Number(level))} ${content}\n\n`,
          )
          .replace(/<\/?(?:div|p|section|aside|br)\b[^>]*>/gi, "\n\n")
          .replace(/<[^>]+>/g, "")
          .replace(/\n{3,}/g, "\n\n")
          .replace(/\]\(\/(?!\/)([^)]*)\)/g, `](${origin}/$1)`);
      }
      output.push(text);
      i = block.end - 1;
    } else {
      output.push(lines[i].replace(/\]\(\/(?!\/)([^)]*)\)/g, `](${origin}/$1)`));
    }
  }
  return output.join("\n").trim();
}

export async function mountHTML(html: string, base: string) {
  return new HTMLRewriter()
    .on("[href], [src], [data-markdown]", {
      element(el) {
        for (const attr of ["href", "src", "data-markdown"]) {
          const value = el.getAttribute(attr);
          if (value?.startsWith("/") && !value.startsWith("//"))
            el.setAttribute(attr, base + value);
        }
      },
    })
    .transform(new Response(html))
    .text();
}
