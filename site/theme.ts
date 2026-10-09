import { join } from "node:path";

// Consume the app's design values without importing its workspace layout,
// component selectors, or Tailwind source scan into the public website.
export async function frontendTheme(): Promise<string> {
  const css = await Bun.file(join(import.meta.dir, "../web/src/main.css")).text();
  const declarations = (source: string) =>
    [
      ...source.matchAll(
        /(--(?:color-[\w-]+|font-(?:sans|mono)|r3-overlay-[\w-]+))\s*:\s*([^;]+);/g,
      ),
    ]
      .map(([, name, value]) => `${name}: ${value.trim()};`)
      .join("\n");
  const theme = css.match(/@theme\s*\{([^}]+)\}/)?.[1] ?? "";
  const roots = [...css.matchAll(/(?:^|\n):root\s*\{([^}]+)\}/g)]
    .map((match) => match[1])
    .join("\n");
  const dark = [...css.matchAll(/(?:^|\n)html\.dark\s*\{([^}]+)\}/g)]
    .map((match) => match[1])
    .join("\n");
  const lightValues = declarations(`${theme}\n${roots}`);
  const darkValues = declarations(dark);
  for (const name of ["--color-primary-600", "--font-sans", "--font-mono", "--r3-overlay-rim"]) {
    if (!lightValues.includes(`${name}:`))
      throw new Error(`Missing frontend design token: ${name}`);
  }
  if (!darkValues.includes("--r3-overlay-rim:"))
    throw new Error("Missing frontend dark overlay tokens");
  return `/* Generated from web/src/main.css. */\n:root {\n${lightValues}\n}\n:root[data-theme="dark"] {\n${darkValues}\n}\n`;
}
