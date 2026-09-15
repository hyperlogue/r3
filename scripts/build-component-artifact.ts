// Build an opaque HTML publication from the real application components.
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { BunPlugin } from "bun";
import { browserLoweredCssPlugin } from "./spa-css.ts";

const root = join(import.meta.dir, "..");

export async function buildComponentArtifact(options: {
  entrypoint: string;
  directory: string;
  title: string;
  navigation?: string;
}) {
  const out = join(root, options.directory);
  const aliases: Record<string, string> = {
    [join(root, "web/src/hooks.ts")]: join(root, "web/src/showcase/theme.ts"),
    [join(root, "web/src/router.ts")]: join(
      root,
      options.navigation ?? "web/src/showcase/navigation.ts",
    ),
    [join(root, "web/src/api.ts")]: join(root, "web/demo/application-api.ts"),
    [join(root, "web/src/artifact-api.ts")]: join(root, "web/demo/artifact-api.ts"),
  };
  const storageConsumers = new Set(
    [
      "store.ts",
      "ui.tsx",
      "useFloatingPanel.ts",
      "artifact-handoff.ts",
      "components/FileBrowser.tsx",
    ].map((path) => join(root, "web/src", path)),
  );
  storageConsumers.add(join(root, "web/demo/artifact-backend.ts"));
  const showcase: BunPlugin = {
    name: "isolated-ui-showcase",
    setup(build) {
      build.onResolve({ filter: /(api|hooks|router)\.ts$/ }, ({ importer, path }) => {
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
    entrypoints: [join(root, options.entrypoint)],
    outdir: out,
    target: "browser",
    minify: true,
    sourcemap: "none",
    plugins: [showcase, await browserLoweredCssPlugin()],
    define: { "process.env.NODE_ENV": '"production"' },
  });
  if (!result.success) throw new AggregateError(result.logs, "Component artifact build failed");
  await Bun.write(
    join(out, "index.html"),
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${options.title}</title><link rel="stylesheet" href="./index.css"></head><body><div id="root"></div><script type="module" src="./index.js"></script></body></html>`,
  );
  console.log(`Built ${options.directory} (index.html, JavaScript, and CSS)`);
}
