// Build the per-platform native `r3` binaries + a SHA256SUMS manifest into
// `dist/`, ready to upload to a GitHub release. Cross-compiles with one
// `Bun.build({ compile: { target } })` per platform (build plugins can't be
// passed to the `bun build --compile` CLI, so we use the API), embedding the
// SPA — with its pre-lowered stylesheet (scripts/spa-css.ts) — the same way
// `scripts/compile.ts` does for the local build.
//
// These assets feed both release channels: uploaded as-is to the GitHub
// Release, and repackaged by scripts/stage-npm-packages.ts into the
// per-platform npm packages the launcher (npm/launch.mjs) resolves. Usage:
// `bun scripts/release-binaries.ts` (then upload dist/* to the matching release).

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { R3_VERSION } from "../shared/version.ts";
import { browserLoweredCssPlugin } from "./spa-css.ts";

const DIR = join(import.meta.dir, "..");
const OUT = join(DIR, "dist");

// Three version sources must agree: shared/version.ts (baked into the binary +
// reported by /api/health), the git tag the assets are uploaded to, and
// npm/package.json (what `bunx @hyperlogue/r3` resolves — the launcher pins its
// platform packages at exactly this version). Fail loudly on drift.
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

// target = Bun cross-compile target; asset = the release asset name, whose
// `<os>-<arch>` suffix must line up with PACKAGES in npm/launch.mjs (via
// stage-npm-packages.ts). Add windows-x64 here + to the launcher (and
// npm/package.json `os`) if/when it's supported.
const PLATFORMS = [
  { target: "bun-darwin-arm64", asset: "r3-darwin-arm64" },
  { target: "bun-darwin-x64", asset: "r3-darwin-x64" },
  { target: "bun-linux-x64", asset: "r3-linux-x64" },
  { target: "bun-linux-arm64", asset: "r3-linux-arm64" },
] as const;

mkdirSync(OUT, { recursive: true });

// The SPA CSS is platform-independent: Tailwind-compile + browser-lower it once
// (see scripts/spa-css.ts) and swap it into every per-platform compile build.
const spaCss = await browserLoweredCssPlugin();

const sums: string[] = [];
for (const { target, asset } of PLATFORMS) {
  console.log(`• compiling ${asset} (${target}) …`);
  const outfile = join(OUT, asset);
  const result = await Bun.build({
    entrypoints: [join(DIR, "cli/index.ts")],
    plugins: [spaCss],
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
