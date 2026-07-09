// Produce the single-file `r3` executable. One `Bun.build` compiles
// the CLI entry — which imports the daemon, which imports `web/index.html` — with
// the Tailwind plugin, so Bun bundles the SPA (HTML/JS/CSS) and embeds it in the
// binary alongside the server + runtime. No generated entry/embed modules: the
// CLI is the binary, and the SPA rides along as `Bun.embeddedFiles`. The one
// binary is both the CLI and the daemon (the hidden `__daemon` subcommand
// re-execs it to serve).

import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";

const DIR = join(import.meta.dir, "..");

console.log("• compiling r3 (CLI + daemon + embedded SPA)…");
const result = await Bun.build({
  entrypoints: [join(DIR, "cli/index.ts")],
  plugins: [tailwind],
  minify: true,
  compile: { outfile: join(DIR, "r3") },
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
console.log("✓ built ./r3");
