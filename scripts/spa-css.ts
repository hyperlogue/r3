// The SPA stylesheet, Tailwind-compiled and *browser-lowered*, as a swap-in
// plugin for the `Bun.build({ compile })` calls (scripts/compile.ts and
// scripts/release-binaries.ts).
//
// Why this exists: a compile build is forced to `target: "bun"` (the binary
// runs on the Bun runtime), and Bun's bun-target CSS printer keeps native CSS
// nesting verbatim — only browser targets get the de-nesting/lowering pass
// (which is why the from-source daemon's production serve path emits valid
// flat CSS while a naive compiled binary doesn't). Tailwind v4's compiler
// *emits* nested rules — its color-mix() fallback wraps declarations in
// `@supports (color: color-mix(in lab, red, red)) { & { … } }` — and expects
// the downstream bundler to lower them. Un-lowered, the preflight's `& { … }`
// under `::placeholder` can never match (`&` means `:is(::placeholder)`, and
// `:is()` accepts no pseudo-elements), so browsers drop the placeholder-dimming
// rule and placeholders render at the input's full text color.
//
// So run Tailwind in a separate browser-target build first — same plugin, same
// entry stylesheet, same `@source` scanning — which lowers all nesting to
// flat, browser-valid selectors, then hand the compile build the result via a
// plain onLoad. Its bun-target CSS printer re-prints flat CSS unchanged (it
// preserves structure — it never re-introduces nesting). Two sequential builds
// on purpose: nesting the browser build inside the compile build's own onLoad
// deadlocks the bundler.

import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";

const MAIN_CSS = join(import.meta.dir, "../web/src/main.css");

export async function browserLoweredCssPlugin(): Promise<Bun.BunPlugin> {
  const cssBuild = await Bun.build({
    entrypoints: [MAIN_CSS],
    target: "browser",
    plugins: [tailwind],
    minify: true,
  });
  const loweredCss = await cssBuild.outputs[0].text();
  return {
    name: "pre-lowered main.css",
    setup(build) {
      build.onLoad({ filter: /web[\\/]src[\\/]main\.css$/ }, () => ({
        contents: loweredCss,
        loader: "css",
      }));
    },
  };
}
