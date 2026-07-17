// Stage the built demo (dist/demo) into a GitHub Pages site layout (dist/pages)
// that serves the app under a sub-path — hyperlogue.github.io/r3/demo/. Run AFTER
// `bun run build:demo` with a matching base (R3_DEMO_BASE=<base_path>/demo), then
// upload dist/pages as the Pages artifact.
//
// Pages serves this repo's artifact at the PROJECT ROOT (/r3/), so we:
//   dist/pages/<subdir>/    ← the whole build, i.e. /r3/demo/
//   dist/pages/404.html     ← a copy of the SPA index
//   dist/pages/index.html   ← a redirect from the bare root to the demo
//
// The 404 lives at the ROOT on purpose: GitHub Pages honors only a SINGLE custom
// 404.html at the site root and ignores any in a subdirectory. A hard reload of
// /r3/demo/review_x has no matching file, so Pages serves /r3/404.html — this
// copy of the SPA, whose asset URLs are absolute (/r3/demo/…, from publicPath),
// so it boots regardless of the requested path and routes client-side.

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
