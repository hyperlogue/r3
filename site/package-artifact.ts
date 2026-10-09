import { cp, mkdir, rm } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { normalizeBase } from "./render.ts";
import { validateLinks } from "./validate.ts";

// Keep the deployable Pages bundle unchanged. Artifact previews require actual
// document paths and relative resources, and cannot host the demo's iframes.
export async function packageArtifact() {
  const source = join(import.meta.dir, "../dist/pages");
  const output = join(import.meta.dir, "../dist/site-artifact");
  const base = normalizeBase(process.env.R3_SITE_BASE);
  const demo = new URL(process.env.R3_SITE_DEMO_URL || "http://localhost:4173/demo/");
  if (!/^https?:$/.test(demo.protocol) || demo.username || demo.password)
    throw new Error("R3_SITE_DEMO_URL must be an HTTP(S) demo address without credentials");
  const documents = new Map<string, string>();
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  for await (const file of new Bun.Glob("**/*").scan({ cwd: source, onlyFiles: true })) {
    if (file.startsWith("demo/") || ["404.html", "robots.txt", "sitemap.xml"].includes(file))
      continue;
    const destination = join(output, file);
    await mkdir(dirname(destination), { recursive: true });
    if (!file.endsWith(".html")) {
      await cp(join(source, file), destination);
      continue;
    }
    const html = await new HTMLRewriter()
      .on("body", {
        element(el) {
          el.setAttribute("data-artifact", "true");
        },
      })
      .on("[href], [src], [data-markdown], [action]", {
        element(el) {
          for (const attr of ["href", "src", "data-markdown", "action"]) {
            const value = el.getAttribute(attr);
            if (!value?.startsWith(`${base}/`) || value.startsWith("//")) continue;
            const url = new URL(value.slice(base.length), "https://example.test");
            if (url.pathname.startsWith("/demo/")) {
              el.setAttribute(attr, demo.href);
              el.setAttribute("target", "_blank");
              el.setAttribute("rel", "noopener");
              el.setAttribute("title", "Open the live demo in a separate browser tab");
              continue;
            }
            if (url.pathname.endsWith("/")) url.pathname += "index.html";
            const path = posix.relative(posix.dirname(file), url.pathname.slice(1));
            el.setAttribute(attr, `${path || "index.html"}${url.search}${url.hash}`);
          }
        },
      })
      .transform(new Response(Bun.file(join(source, file))))
      .text();
    await Bun.write(destination, html);
    documents.set(file, html);
  }
  await validateLinks(output, documents, "");
  console.log(`Packaged ${documents.size} pages → dist/site-artifact`);
  console.log(`Live demo opens separately: ${demo.href}`);
}

if (import.meta.main) await packageArtifact();
