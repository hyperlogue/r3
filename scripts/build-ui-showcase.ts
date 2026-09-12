// Build a self-contained HTML publication using the current application components.
// Run: bun scripts/build-ui-showcase.ts; publish dist/ui-showcase with r3 create.
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BunPlugin } from "bun";
import { browserLoweredCssPlugin } from "./spa-css.ts";

const root = join(import.meta.dir, "..");
const out = join(root, "dist/ui-showcase");
const aliases: Record<string, string> = {
  [join(root, "web/src/api.ts")]: join(root, "web/demo/application-api.ts"),
  [join(root, "web/src/artifact-api.ts")]: join(root, "web/demo/artifact-api.ts"),
};
const storageConsumers = new Set(
  ["store.ts", "ui.tsx", "components/FileBrowser.tsx"].map((path) => join(root, "web/src", path)),
);
const showcase: BunPlugin = {
  name: "isolated-ui-showcase",
  setup(build) {
    build.onResolve({ filter: /api\.ts$/ }, ({ importer, path }) => {
      const alias = aliases[resolve(dirname(importer), path)];
      return alias ? { path: alias } : undefined;
    });
    build.onLoad({ filter: /\.(ts|tsx)$/ }, async ({ path }) => {
      if (!storageConsumers.has(path)) return undefined;
      // Opaque previews have no browser storage. Keep display preferences in
      // memory only in this bundle, without changing the production components.
      return {
        contents: `import { memoryStorage as localStorage } from ${JSON.stringify(join(root, "web/src/showcase/storage.ts"))};\n${await Bun.file(path).text()}`,
        loader: path.endsWith("tsx") ? "tsx" : "ts",
      };
    });
  },
};
await rm(out, { recursive: true, force: true });
const result = await Bun.build({
  entrypoints: [join(root, "web/src/showcase/index.tsx")],
  outdir: out,
  target: "browser",
  minify: true,
  sourcemap: "none",
  plugins: [showcase, await browserLoweredCssPlugin()],
  define: { "process.env.NODE_ENV": '"production"' },
});
if (!result.success) throw new AggregateError(result.logs, "Showcase build failed");
await Bun.write(
  join(out, "index.html"),
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>r3 UI component showcase</title><link rel="stylesheet" href="./index.css"></head><body><div id="root"></div><script type="module" src="./index.js"></script></body></html>',
);
console.log("Built dist/ui-showcase (index.html, JavaScript, and CSS)");
