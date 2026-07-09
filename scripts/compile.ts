// Produce the single-file `r3` executable. One `Bun.build` compiles
// the CLI entry — which imports the daemon, which imports `web/index.html` — with
// the pre-lowered SPA stylesheet (see scripts/spa-css.ts for why the CSS is
// Tailwind-compiled in a browser-target pass first), so Bun bundles the SPA
// (HTML/JS/CSS) and embeds it in the binary alongside the server + runtime. No
// generated entry/embed modules: the CLI is the binary, and the SPA rides along
// as `Bun.embeddedFiles`. The one binary is both the CLI and the daemon (the
// hidden `__daemon` subcommand re-execs it to serve).

import { join } from "node:path";
import { browserLoweredCssPlugin } from "./spa-css.ts";

const DIR = join(import.meta.dir, "..");

console.log("• bundling SPA stylesheet (browser-lowered)…");
const spaCss = await browserLoweredCssPlugin();

console.log("• compiling r3 (CLI + daemon + embedded SPA)…");
const result = await Bun.build({
  entrypoints: [join(DIR, "cli/index.ts")],
  plugins: [spaCss],
  minify: true,
  compile: { outfile: join(DIR, "r3") },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log("✓ built ./r3");
