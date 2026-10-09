import { resolve, sep } from "node:path";
import { normalizeBase } from "./render.ts";

export function serveSite(directory: string, options: { base?: string; port?: number } = {}) {
  const root = resolve(directory);
  const base = normalizeBase(options.base);
  return Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 4173,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === base && base)
        return Response.redirect(new URL(`${base}/${url.search}`, url), 302);
      if (!url.pathname.startsWith(`${base}/`))
        return new Response("Outside the site mount", { status: 404 });
      let path: string;
      try {
        path = decodeURIComponent(url.pathname.slice(base.length + 1));
      } catch {
        return new Response("Invalid path", { status: 400 });
      }
      const filePath = resolve(root, path || "index.html");
      if (filePath !== root && !filePath.startsWith(root + sep))
        return new Response("Not found", { status: 404 });
      const file = Bun.file(path.endsWith("/") ? resolve(filePath, "index.html") : filePath);
      if (await file.exists()) return new Response(file);
      const index = Bun.file(resolve(filePath, "index.html"));
      if (!path.endsWith("/") && (await index.exists()))
        return Response.redirect(new URL(`${url.pathname}/${url.search}`, url), 302);
      return new Response(Bun.file(resolve(root, "404.html")), { status: 404 });
    },
  });
}

if (import.meta.main) {
  const server = serveSite(resolve(import.meta.dir, "../dist/pages"), {
    base: process.env.R3_SITE_BASE,
    port: Number(process.env.R3_SITE_PORT || 4173),
  });
  console.log(`Preview: ${server.url.origin}${normalizeBase(process.env.R3_SITE_BASE)}/`);
}
