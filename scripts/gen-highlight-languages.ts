// Refresh after upgrading Shiki: bun scripts/gen-highlight-languages.ts
// Only this development-time collector loads every grammar. The daemon imports
// the small generated filename index and loads grammars only for highlighting.
import { fileURLToPath } from "node:url";
import { bundledLanguagesInfo } from "shiki";
import { version } from "shiki/package.json";

export async function collectLanguageFileTypes() {
  const languages: Record<string, string[]> = {};
  for (const info of bundledLanguagesInfo) {
    const { default: grammars } = await info.import();
    const grammar = grammars.find((grammar) => grammar.name === info.id);
    if (!grammar) throw new Error(`Missing bundled grammar: ${info.id}`);
    languages[info.id] = [...new Set(grammar.fileTypes ?? [])].sort();
  }
  return { shikiVersion: version, languages };
}

if (import.meta.main) {
  await Bun.write(
    new URL("../server/highlight-file-types.gen.json", import.meta.url),
    `${JSON.stringify(await collectLanguageFileTypes(), null, 2)}\n`,
  );
  const formatted = Bun.spawnSync(
    ["biome", "format", "--write", "server/highlight-file-types.gen.json"],
    { cwd: fileURLToPath(new URL("..", import.meta.url)), stdout: "inherit", stderr: "inherit" },
  );
  if (!formatted.success) process.exit(formatted.exitCode || 1);
}
