// Single-file `r3` executable (`Bun.build --compile`). CSS is pre-lowered
// (scripts/spa-css.ts) because bun-target keeps native nesting.

import { join } from "node:path";
import { browserLoweredCssPlugin } from "./spa-css.ts";

const DIR = join(import.meta.dir, "..");

console.log("• bundling SPA stylesheet (browser-lowered)…");
const spaCss = await browserLoweredCssPlugin();

console.log("• compiling r3 (CLI + daemon + embedded SPA)…");
const result = await Bun.build({
  entrypoints: [
    join(DIR, "cli/index.ts"),
    // bun --compile does not auto-embed `new Worker(new URL("./x", import.meta.url))`.
    join(DIR, "server/highlight-worker.ts"),
  ],
  plugins: [spaCss],
  minify: true,
  // Without this the SPA bundle resolves React's *development* export, which
  // ships ~200 KB of dev machinery and makes <StrictMode> double-invoke every
  // effect in the released binary. `Bun.serve`'s own HTML bundling (the
  // from-source daemon) already defaults to production; --compile does not.
  define: { "process.env.NODE_ENV": '"production"' },
  compile: { outfile: join(DIR, "r3") },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log("✓ built ./r3");
