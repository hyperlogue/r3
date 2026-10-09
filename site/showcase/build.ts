import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";

export async function buildShowcase(directory: string) {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "index.tsx"), join(import.meta.dir, "style.css")],
    outdir: directory,
    target: "browser",
    minify: true,
    plugins: [tailwind],
    naming: "[name].[ext]",
    publicPath: "./",
    metafile: true,
  });
  if (!result.success) throw new AggregateError(result.logs, "Fieldwork workspace build failed");
  // Keep the reusable UI and this static host independent of the connected app.
  const inputs = Object.keys(result.metafile!.inputs);
  const connected = inputs.filter((path) =>
    /web\/src\/(api\.ts|artifact-api\.ts|router\.ts|preview-sessions\.ts)$|^server\//.test(path),
  );
  if (connected.length)
    throw new Error(`Fieldwork imported connected app code: ${connected.join(", ")}`);
  await Bun.write(
    join(directory, "index.html"),
    `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, interactive-widget=resizes-content"><title>Example Fieldwork · r3</title><meta name="robots" content="noindex"><link rel="stylesheet" href="./style.css"></head><body><div id="root"></div><noscript>This interactive example needs JavaScript. <a href="../index.html">Return to the r3 homepage</a>.</noscript><script type="module" src="./index.js"></script></body></html>`,
  );
}
