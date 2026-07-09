// Fail when bun.nix has drifted from bun.lock.
//
// bun.nix is bun2nix's generated mirror of the lockfile — the nix build
// (nix/r3.nix fetchBunDeps) installs deps from it, never from the registry. A
// change that touches bun.lock without regenerating bun.nix (a Dependabot
// bump, a hand-edited dependency) would leave `nix build` on stale deps or
// break it outright, and nothing in the bun-only CI path would notice. This
// check compares the resolved `name@version` set on both sides so CI catches
// the drift; it deliberately needs no nix, so it runs in the same job as the
// other checks. Hashes aren't compared — a same-version re-resolve is not a
// drift mode bun.lock has.
//
// To fix a failure: regenerate with `bun2nix -o bun.nix` (in the dev shell),
// commit the result alongside the lockfile change.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = join(import.meta.dir, "..");

// bun.lock is JSONC (trailing commas). Nothing in it is free-form prose, so
// stripping `,` before a closing bracket can't corrupt a value.
const lock = JSON.parse(readFileSync(join(DIR, "bun.lock"), "utf8").replace(/,(\s*[}\]])/g, "$1"));

// packages: { "<key>": ["name@version", ...], ... } — element 0 is the
// resolved specifier, which is exactly the key bun2nix emits.
const fromLock = new Set<string>(
  Object.values(lock.packages as Record<string, [string, ...unknown[]]>).map((v) => v[0]),
);

// bun.nix is generated nix we don't want to evaluate here; its package keys
// are the `  "name@version" = fetch…` attribute lines.
const nix = readFileSync(join(DIR, "bun.nix"), "utf8");
const fromNix = new Set<string>(
  [...nix.matchAll(/^ {2}"([^"]+)" = /gm)].map((m) => m[1] as string),
);

const missing = [...fromLock].filter((p) => !fromNix.has(p)).sort();
const stale = [...fromNix].filter((p) => !fromLock.has(p)).sort();

if (missing.length === 0 && stale.length === 0) {
  console.log(`bun.nix is in sync with bun.lock (${fromLock.size} packages).`);
  process.exit(0);
}

for (const p of missing) console.error(`in bun.lock but not bun.nix: ${p}`);
for (const p of stale) console.error(`in bun.nix but not bun.lock:  ${p}`);
console.error(
  "\nbun.nix has drifted from bun.lock — regenerate it (`bun2nix -o bun.nix` in the dev shell) and commit it with the lockfile change.",
);
process.exit(1);
