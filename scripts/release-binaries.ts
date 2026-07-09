// Build the per-platform native `r3` binaries + a SHA256SUMS manifest into
// `dist/`, ready to upload to a GitHub release. Cross-compiles with one
// `Bun.build({ compile: { target } })` per platform (the Tailwind plugin can't
// be passed to the `bun build --compile` CLI, so we use the API), embedding the
// SPA the same way `scripts/compile.ts` does for the local build.
//
// The launcher (npm/launch.mjs) downloads `<asset>` + `SHA256SUMS` from the
// release tag `v<version>` and verifies the checksum — so the asset names here
// and the version tag must line up with npm/package.json. Usage: `bun
// scripts/release-binaries.ts` (then upload dist/* to the matching release).

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import tailwind from "bun-plugin-tailwind";
import { R3_VERSION } from "../shared/version.ts";

const DIR = join(import.meta.dir, "..");
const OUT = join(DIR, "dist");

// The launcher downloads from the release tag matching its own npm version, so
// the three version sources must agree: shared/version.ts (baked into the binary
// + reported by /api/health), the git tag the assets are uploaded to, and
// npm/package.json (what `bunx @hyperlogue/r3` resolves). Fail loudly on drift.
const npmVersion = JSON.parse(readFileSync(join(DIR, "npm/package.json"), "utf8")).version;
if (npmVersion !== R3_VERSION) {
  console.error(
    `version mismatch: npm/package.json is ${npmVersion} but shared/version.ts is ${R3_VERSION}.\n` +
      `Sync them, then upload dist/* to a release tagged v${R3_VERSION}.`,
  );
  process.exit(1);
}
console.log(
  `Building r3 v${R3_VERSION} — upload dist/* to the GitHub release tagged v${R3_VERSION}.`,
);

// target = Bun cross-compile target; asset = the name the launcher requests
// (must match ASSETS in npm/launch.mjs). Add windows-x64 here + to the launcher
// (and npm/package.json `os`) if/when it's supported.
const PLATFORMS = [
  { target: "bun-darwin-arm64", asset: "r3-darwin-arm64" },
  { target: "bun-darwin-x64", asset: "r3-darwin-x64" },
  { target: "bun-linux-x64", asset: "r3-linux-x64" },
  { target: "bun-linux-arm64", asset: "r3-linux-arm64" },
] as const;

mkdirSync(OUT, { recursive: true });

const sums: string[] = [];
for (const { target, asset } of PLATFORMS) {
  console.log(`• compiling ${asset} (${target}) …`);
  const outfile = join(OUT, asset);
  const result = await Bun.build({
    entrypoints: [join(DIR, "cli/index.ts")],
    plugins: [tailwind],
    minify: true,
    compile: { target, outfile },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  const sha = createHash("sha256").update(readFileSync(outfile)).digest("hex");
  sums.push(`${sha}  ${asset}`);
}

writeFileSync(join(OUT, "SHA256SUMS"), `${sums.join("\n")}\n`);
console.log(`✓ built ${PLATFORMS.length} binaries + SHA256SUMS in dist/`);
