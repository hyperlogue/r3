// Frontend-only demo build. Aliases web/src/api.ts → web/demo/api.ts. R3_DEMO_BASE
// is the mount prefix (GitHub Pages project sites serve under /<repo>/).

import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BunPlugin } from "bun";
import tailwind from "bun-plugin-tailwind";

const DIR = join(import.meta.dir, "..");
const OUT = join(DIR, "dist/demo");

// web/src modules the demo build swaps for its own: api.ts routes every fetch/SSE
// call to the in-browser backend; demo-chrome.tsx replaces the production no-op
// stub with the real "Demo" badge + intro; main.css swaps in a CSS entry that
// also scans web/demo for Tailwind classes (see web/demo/main.css), so the demo
// chrome's utilities actually get generated.
const ALIASES: Record<string, string> = {
  [join(DIR, "web/src/api.ts")]: join(DIR, "web/demo/api.ts"),
  [join(DIR, "web/src/demo-chrome.tsx")]: join(DIR, "web/demo/demo-chrome.tsx"),
  [join(DIR, "web/src/main.css")]: join(DIR, "web/demo/main.css"),
};

// Normalize R3_DEMO_BASE to a leading+trailing-slash prefix: "/" (root),
// "/r3/" (a project page), or "/r3/demo/" (a sub-path within one). split/filter
// collapses empties so a stray "//" or a trailing slash can't leak through.
const slug = (process.env.R3_DEMO_BASE ?? "/").split("/").filter(Boolean).join("/");
const BASE = slug ? `/${slug}/` : "/";

// Redirect the aliased web/src modules to their web/demo counterparts. Every
// importer reaches them as "./x" or "../x"; resolve against the importer and match
// the exact file so nothing else with the same basename is touched.
const aliasDemo: BunPlugin = {
  name: "r3-demo-alias",
  setup(build) {
    build.onResolve({ filter: /(api\.ts|demo-chrome\.tsx|main\.css)$/ }, (args) => {
      if (!args.importer) return undefined;
      const target = resolve(dirname(args.importer), args.path);
      const to = ALIASES[target];
      return to ? { path: to } : undefined;
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
  plugins: [tailwind, aliasDemo],
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
