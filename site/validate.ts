import { join } from "node:path";

export async function validateLinks(directory: string, pages: Map<string, string>, base: string) {
  const documents = new Map<string, { ids: Set<string>; links: string[] }>();
  for (const [file, html] of pages) {
    const ids = new Set<string>();
    const links: string[] = [];
    await new HTMLRewriter()
      .on("[id]", {
        element(el) {
          const id = el.getAttribute("id")!;
          if (ids.has(id)) throw new Error(`Duplicate anchor in ${file}: ${id}`);
          ids.add(id);
        },
      })
      .on("[href], [src], [data-markdown]", {
        element(el) {
          for (const attr of ["href", "src", "data-markdown"]) {
            const value = el.getAttribute(attr);
            if (value) links.push(value);
          }
        },
      })
      .transform(new Response(html))
      .text();
    documents.set(file, { ids, links });
  }
  for (const [source, { links }] of documents) {
    for (const link of links) {
      if (/^(?:[a-z]+:|\/\/)/i.test(link)) continue;
      const url = new URL(link, `https://example.test${base}/${source}`);
      if (!url.pathname.startsWith(`${base}/`))
        throw new Error(`Link escapes mount in ${source}: ${link}`);
      const relative = decodeURIComponent(url.pathname.slice(base.length + 1));
      const target = relative.endsWith("/") || !relative ? `${relative}index.html` : relative;
      if (!(await Bun.file(join(directory, target)).exists()))
        throw new Error(`Missing link in ${source}: ${link}`);
      if (
        url.hash &&
        documents.has(target) &&
        !documents.get(target)!.ids.has(decodeURIComponent(url.hash.slice(1)))
      )
        throw new Error(`Missing anchor in ${source}: ${link}`);
    }
  }
}
