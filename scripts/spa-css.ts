// Pre-lower SPA CSS for compile builds: bun-target keeps native CSS nesting, so
// Tailwind must be compiled in a browser-target pass first. Two sequential builds
// — nesting the browser build inside compile onLoad deadlocks the bundler.

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
  if (!cssBuild.success || !cssBuild.outputs[0]) {
    for (const log of cssBuild.logs) console.error(log);
    process.exit(1);
  }
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
