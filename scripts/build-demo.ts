// Build the frontend-only demo: a static SPA whose "backend" is the in-browser
// store in web/demo/. One Bun.build over the same web/index.html the daemon
// serves, with two twists:
//   1. bun-plugin-tailwind bundles the SPA stylesheet (browser target lowers
//      Tailwind's nesting fine — unlike the compile build, see scripts/spa-css.ts).
//   2. an alias plugin redirects the SPA's web/src/api.ts to web/demo/api.ts, so
//      every fetch/SSE call routes to the browser backend instead of a daemon.
// Output is a self-contained dist/demo/ you can host anywhere static (GitHub
// Pages, Netlify, `bunx serve`), with no r3 daemon and no git.
//
// Sub-path hosting: GitHub Pages serves a project site under /<repo>/, so assets
// AND the router must know that prefix. R3_DEMO_BASE (default "/" for a root
// `bunx serve`) sets it — the Pages workflow passes the base_path configure-pages
// reports. It feeds Bun's publicPath (asset URLs) and __R3_BASE__ (the router).

import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BunPlugin } from "bun";
import tailwind from "bun-plugin-tailwind";

const DIR = join(import.meta.dir, "..");
const REAL_API = join(DIR, "web/src/api.ts");
const DEMO_API = join(DIR, "web/demo/api.ts");
const OUT = join(DIR, "dist/demo");

// Normalize R3_DEMO_BASE to a leading+trailing-slash prefix: "/" (root),
// "/r3/" (a project page), or "/r3/demo/" (a sub-path within one). split/filter
// collapses empties so a stray "//" or a trailing slash can't leak through.
const slug = (process.env.R3_DEMO_BASE ?? "/").split("/").filter(Boolean).join("/");
const BASE = slug ? `/${slug}/` : "/";

// Redirect only the SPA's own api module (web/src/api.ts). Every importer reaches
// it as "./api.ts" or "../api.ts"; resolve against the importer and match the
// exact file so nothing else ending in api.ts is touched.
const aliasDemoApi: BunPlugin = {
  name: "r3-demo-api-alias",
  setup(build) {
    build.onResolve({ filter: /api\.ts$/ }, (args) => {
      if (!args.importer) return undefined;
      const target = resolve(dirname(args.importer), args.path);
      return target === REAL_API ? { path: DEMO_API } : undefined;
    });
  },
};

console.log(`• building frontend-only demo (dist/demo, base ${BASE})…`);
// Wipe the outdir first — Bun.build hashes filenames but never prunes, so stale
// chunks from a prior build would otherwise pile up next to the current one.
await rm(OUT, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [join(DIR, "web/index.html")],
  outdir: OUT,
  plugins: [tailwind, aliasDemoApi],
  minify: true,
  sourcemap: "none",
  // publicPath prefixes every emitted asset URL so they resolve from a deep
  // route (e.g. /r3/review_x served via 404.html), not just the index.
  publicPath: BASE,
  define: {
    "process.env.NODE_ENV": '"production"',
    __R3_BASE__: JSON.stringify(BASE),
  },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

// SPA deep-link fallback: GitHub Pages serves 404.html for any unmatched path, so
// a copy of index.html there lets a hard reload of /…/review_x boot the app (which
// then routes client-side) instead of 404ing.
await Bun.write(join(OUT, "404.html"), await Bun.file(join(OUT, "index.html")).bytes());

console.log(`✓ built ${result.outputs.length + 1} files → dist/demo (open dist/demo/index.html)`);
