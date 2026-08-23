// Stage dist/demo into a GitHub Pages layout. Pages honors only a SINGLE custom
// 404.html at the site root (deep-link reload fallback); index.html redirects to
// the demo subdir.

import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..");
const BUILD = join(DIR, "dist/demo");
const OUT = join(DIR, "dist/pages");
// The sub-path folder name (the "demo" in /r3/demo/). Must match the last segment
// of the R3_DEMO_BASE the build used; the workflow sets both from one constant.
const SUBDIR = process.env.R3_DEMO_SUBDIR || "demo";

const index = Bun.file(join(BUILD, "index.html"));
if (!(await index.exists())) {
  console.error("dist/demo/index.html not found — run `bun run build:demo` first.");
  process.exit(1);
}

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
await cp(BUILD, join(OUT, SUBDIR), { recursive: true });

// Site-root 404 = the SPA (deep-link reload fallback; see header).
await Bun.write(join(OUT, "404.html"), await index.bytes());

// Bare project root just bounces to the demo (meta-refresh + a visible link for
// no-JS). Relative "./<subdir>/" resolves against whatever root Pages mounts at.
await Bun.write(
  join(OUT, "index.html"),
  `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="refresh" content="0; url=./${SUBDIR}/" />
    <link rel="canonical" href="./${SUBDIR}/" />
    <title>r3 — live demo</title>
  </head>
  <body>
    <a href="./${SUBDIR}/">r3 live demo →</a>
  </body>
</html>
`,
);

console.log(`✓ staged dist/pages — site root + SPA 404 fallback; demo under /${SUBDIR}/`);
