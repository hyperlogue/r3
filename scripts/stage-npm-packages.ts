// Stage the four per-platform npm packages (@hyperlogue/r3-<os>-<arch>) that
// carry the prebuilt binaries, and stamp the launcher's optionalDependencies to
// match. Run AFTER scripts/release-binaries.ts has produced dist/<asset>.
//
// The launcher (npm/launch.mjs) resolves the matching package at runtime via
// createRequire — no download — so each package's version must equal the
// launcher's own version, and the launcher must be published only after these
// packages exist (release.yml enforces the order). This script is the single
// authority for that lockstep: it stamps every pin from the one version source,
// so a release bumps only the top-level version and the pins follow.
//
// Usage: `bun scripts/stage-npm-packages.ts` -> dist/npm/<pkg>/{package.json,bin/r3,LICENSE}.

import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { R3_VERSION } from "../shared/version.ts";

const DIR = join(import.meta.dir, "..");
const DIST = join(DIR, "dist");
const OUT = join(DIST, "npm");
const SCOPE = "@hyperlogue";

// The same identity block the launcher advertises. `repository.url` is REQUIRED
// for `npm publish --provenance` to attest each package, and matches the repo the
// release workflow runs in.
const REPOSITORY = { type: "git", url: "git+https://github.com/hyperlogue/r3.git" };
const HOMEPAGE = "https://github.com/hyperlogue/r3#readme";
const BUGS = "https://github.com/hyperlogue/r3/issues";

// asset = the file release-binaries.ts built into dist/; os/cpu/libc drive npm's
// optional-dependency selection on install. Keep in sync with the PLATFORMS in
// release-binaries.ts and the PACKAGES map in npm/launch.mjs.
const PLATFORMS: { asset: string; os: string; cpu: string; libc?: string }[] = [
  { asset: "r3-darwin-arm64", os: "darwin", cpu: "arm64" },
  { asset: "r3-darwin-x64", os: "darwin", cpu: "x64" },
  { asset: "r3-linux-x64", os: "linux", cpu: "x64", libc: "glibc" },
  { asset: "r3-linux-arm64", os: "linux", cpu: "arm64", libc: "glibc" },
];

// Guard the version lockstep the launcher depends on (mirrors release-binaries.ts):
// npm/package.json and shared/version.ts must already agree before we stamp pins.
const launcherPkgPath = join(DIR, "npm/package.json");
const launcherPkg = JSON.parse(readFileSync(launcherPkgPath, "utf8"));
if (launcherPkg.version !== R3_VERSION) {
  console.error(
    `version mismatch: npm/package.json is ${launcherPkg.version} but shared/version.ts is ${R3_VERSION}.\n` +
      `Sync them before staging the npm packages.`,
  );
  process.exit(1);
}

mkdirSync(OUT, { recursive: true });

const optionalDependencies: Record<string, string> = {};
for (const { asset, os, cpu, libc } of PLATFORMS) {
  const name = `${SCOPE}/${asset}`;
  const pkgDir = join(OUT, asset);
  const binDir = join(pkgDir, "bin");
  mkdirSync(binDir, { recursive: true });

  const bin = join(binDir, "r3");
  copyFileSync(join(DIST, asset), bin);
  // Bun.build's output isn't executable and npm preserves tarball file modes, so
  // set the exec bit here — otherwise every install lands a 0644 binary that
  // won't spawn (EACCES).
  chmodSync(bin, 0o755);

  const pkg: Record<string, unknown> = {
    name,
    version: R3_VERSION,
    description: `Prebuilt r3 binary for ${os}-${cpu}.`,
    license: "MIT",
    os: [os],
    cpu: [cpu],
    // `libc` lets npm >=9.6 skip a glibc package on musl; the launcher's
    // checkLibc is the real guard for older npm / Bun that ignore this field.
    ...(libc ? { libc: [libc] } : {}),
    repository: REPOSITORY,
    homepage: HOMEPAGE,
    bugs: BUGS,
    // No `bin` (the launcher owns the `r3` command) and no `exports` (it would
    // block the `bin/r3` subpath the launcher resolves). Just ship the file.
    files: ["bin/r3"],
    publishConfig: { access: "public" },
  };
  writeFileSync(join(pkgDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  copyFileSync(join(DIR, "npm/LICENSE"), join(pkgDir, "LICENSE"));

  optionalDependencies[name] = R3_VERSION;
}

// Stamp the launcher's optionalDependencies from the one version source so the
// pins can never drift from the packages we just built.
launcherPkg.optionalDependencies = optionalDependencies;
writeFileSync(launcherPkgPath, `${JSON.stringify(launcherPkg, null, 2)}\n`);

console.log(
  `✓ staged ${PLATFORMS.length} platform packages in dist/npm/ and stamped launcher pins to v${R3_VERSION}`,
);
