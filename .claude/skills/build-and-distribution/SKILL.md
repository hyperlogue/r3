---
name: build-and-distribution
description: How r3 is built and shipped — the single-file Bun.build --compile binary and its browser-target Tailwind CSS pre-pass, the two release channels (GitHub Releases + the npm launcher with per-platform optional-dependency packages), the `bun` → empty-npm-package override, and the public website and frontend-only demo deployed to GitHub Pages. Use when touching scripts/ (compile, spa-css, release-binaries, stage-npm-packages, wait-for-npm-packages, build-demo, stage-pages, gen-artifact-demo), npm/, web/demo/, site/, bunfig.toml, the nix build, the Pages or release workflows, or debugging a broken binary/site/demo build.
---

# Building and shipping r3

This file is the **design source of truth** for r3's build + distribution — update
it here when the pipeline changes. (Cutting an actual release — changelog, version
bump, tag — is the separate **`release`** skill.)

## The single-file binary

`bun run build` runs **one** `Bun.build({ compile })` (`scripts/compile.ts`) over
the CLI entry — which imports the daemon, which imports the SPA via `import index
from "../web/index.html"`. That embeds the Bun runtime, all JS deps, `bun:sqlite`,
and the bundled SPA (as `Bun.embeddedFiles`) into one `./r3` executable that serves
its own UI. `application-assets.ts` indexes embedded files and serves them behind
the application Host guard. A source daemon bundles the same assets once at
startup; frontend edits need a restart. Native Bun HMR routes are not exposed
outside the guards. The CLI **is** the binary; the hidden `__daemon` subcommand
re-execs it to serve.

**The CSS pre-pass is load-bearing.** The SPA stylesheet is Tailwind-compiled first
in a separate **browser-target** pass (`scripts/spa-css.ts`, shared with
`release-binaries.ts`). A compile build is `target:"bun"`, whose CSS printer keeps
Tailwind's native nesting verbatim — and un-lowered nesting breaks in browsers
(`& {…}` under `::placeholder` is unmatchable, so placeholders lose their dimming).
The pre-pass lowers it flat; the compile build embeds it as-is. Don't remove it.

## Two release channels, one tag-driven pipeline

`scripts/release-binaries.ts` cross-compiles the four `r3-<os>-<arch>` binaries.
From there:

- **GitHub Releases** carry the raw assets (curl / Homebrew). No checksum
  manifest ships with them — GitHub publishes a sha256 digest per asset, and the
  build job verifies against those digests on the reuse path.
- **npm** ships a tiny launcher (`@hyperlogue/r3`, `npm/launch.mjs`) whose
  per-platform binaries are **optional-dependency packages**
  (`@hyperlogue/r3-<os>-<arch>`, staged by `scripts/stage-npm-packages.ts`). npm
  installs only the matching package, so `bunx`/`npx @hyperlogue/r3@x.y.z`
  resolves-and-execs that version's binary with **no runtime download** — the
  launcher only does `createRequire().resolve` + `spawn`.

**npm auth is trusted publishing (OIDC) — there is no npm token.** Each of the
five packages registers `release.yml` *by filename* as its trusted publisher on
npmjs.com, and npm mints a short-lived publish-only credential from the runner's
OIDC identity. So: **renaming `.github/workflows/release.yml` breaks publishing**
until all five registrations are updated, publishing can't move to another
workflow or a self-hosted runner, and a **brand-new** package name (adding a
platform target) has no trusted publisher yet — its first publish is manual, then
register `release.yml` on it. Requires npm ≥ 11.5.1. The shared toolchain pins
an OIDC-capable npm and omits setup-node's `registry-url` (its `.npmrc`
placeholder token would shadow OIDC).

### Native verification, one approval gate

`release.yml` is **verify → build → binaries → publish**. The single `publish` job creates
or reuses the GitHub Release, publishes the four platform packages, waits for
all exact platform pins to become visible, then publishes the launcher.
**Re-run failed jobs** repeats this job safely: an existing published release
and its assets stay untouched, and npm versions already on the registry are
skipped.

- **`verify`** checks the tag *shape* (plain SemVer — a git ref may contain
  `$( )`, backticks and `;`, so an unvalidated tag reaching a `run:` block is an
  injection vector) and the tag ↔ `npm/package.json` lockstep, then exports the
  verified version. A missing `## [X.Y.Z]` changelog section only **warns** —
  the release falls back to `--generate-notes`.
- **`build`** compiles (or re-downloads and digest-verifies this tag's existing
  assets) and hands `dist/r3-*` to native verification. It can only read.
- **`binaries`** uses `verify-binaries.yml` on all four native platforms. Fresh
  macOS builds receive an ad-hoc signature; reused assets remain byte-identical.
  `scripts/verify-binary.ts` checks macOS signatures with `codesign --verify --strict`,
  then copies the binary outside the checkout and checks CLI startup, a private
  daemon, embedded JS/CSS, publication, source highlighting, binary downloads and
  persistence after restart. Publish consumes only the `r3-verified-*` outputs.
  An invalid reused asset fails verification rather than being silently repaired.
- **`publish`** checks for the GitHub Release before downloading the build
  artifact. Only a 404 permits creation; other API failures and an unfinished
  draft stop publication. If the release exists, skip the artifact download,
  binary check, and creation. Never re-upload assets on a retry: immutable
  releases reject that write before npm can resume.

Only `publish` uses **`environment: release`**, so each attempt requires one
approval. Each npm package's trusted publisher names that environment and the
`release.yml` workflow; keep both names. Configure the environment's required
reviewers (GitHub creates it implicitly, so it runs ungated until configured)
and a tag ruleset on `v*`. A tag push bypasses branch protection: without the
gate, anyone with write access could tag an arbitrary commit into an npm publish.
The workflow defaults to `contents: read`; only the gated job receives
`contents: write` and `id-token: write`.

npm packages always stage the **published GitHub assets**, including on the
first attempt. Clear the downloaded build binaries before fetching those assets,
so a missing release asset cannot be silently supplied by a different build.
Stage once to produce all four packages and the launcher's exact pins. Keep
platform publication, registry visibility, and launcher publication in that order.

`scripts/wait-for-npm-packages.sh` gives the launcher one ten-minute deadline
for every exact platform pin. Each poll revalidates npm metadata
(`--prefer-online`) and bounds the registry request, so a stall cannot outlive
the deadline. Run `bun test scripts/wait-for-npm-packages.test.mjs` when changing
that wait; a bare `bun test` does not discover `.mjs`. The workflow retry checks
in `scripts/release-workflow.test.ts` exercise publication with fake GitHub and
npm commands. CI runs both suites without publishing.

**The publish job never execs a release binary.** It only stats staged exec bits;
Native runners already verified every target. Executing an unverified binary
with publish credentials could let it rewrite the other platform packages.
The build artifact's `retention-days: 7` bounds how long initial approval may
idle. Past that, re-run the workflow so `build` can compile again. Once the
GitHub Release exists, npm retries skip that artifact and work after it expires.

## `package.json` overrides `bun` → `empty-npm-package`

`bun-plugin-tailwind` peer-depends on the `bun` npm package, which would pull
Oven's wrapper + 16 platform binaries into `bun.lock` (and thus `bun.nix` and the
nix build's fetch set), and whose broken bin shim shadows `bun` on install-script
PATHs. The override pins that name to an empty stub.

The plugin has no public source repo — report issues to `oven-sh/bun`, and drop the
override if a release marks the peer optional or moves it to `engines`.

## The frontend-only demo → GitHub Pages

`bun run build:demo` (`scripts/build-demo.ts`) produces a static `dist/demo/` that
runs the **whole SPA with no daemon** — a third client of the same components, but
its "backend" is an **in-memory store** (`web/demo/`). Practice messages,
publications, and message image bytes last for the page visit; reload resets them.
The demo build also gives drafts an in-memory storage adapter.

It uses the same `web/index.html` and application components. One build plugin
aliases five exact imports:

| Application module | Demo replacement |
| --- | --- |
| `web/src/api.ts` | `web/demo/application-api.ts` — boot/theme and disabled login management |
| `web/src/artifact-api.ts` | `web/demo/artifact-api.ts` — typed artifact API and local event stream |
| `web/src/demo-chrome.tsx` | `web/demo/demo-chrome.tsx` — intro/reset |
| `web/src/artifact-renderer.tsx` | `web/demo/artifact-renderer.tsx` — bundled static previews |
| `web/src/main.css` | `web/demo/main.css` — also scans demo classes |

`ArtifactDemoBackend` owns seeded publications, conversations, delivery, claims,
and lifecycle in memory. An async event stream invalidates the same
queries as production. There is no global EventSource or fetch shim.

`scripts/gen-artifact-demo.ts` → `web/demo/artifact-fixtures.gen.ts` bakes two
public demo artifacts: an interactive HTML curve lab and a six-file diff review.
Each starts with four already-sent conversations: two human-authored and two
agent-authored, with comments, three open threads, and one resolved thread.
The curve lab embeds `samples/curve-lab.js` inline, with no external chart library;
its sliders update the approximation, residual plot, and sampled error metrics.
The generated workshop seed also retains the Files example for the component
showcases and tutorial. Complete versions, original bytes, retained Markdown HTML,
theme palettes, and scripted follow-up publications share the same generator.
Preview documents are a separate generated export; they are not restored from browser storage.
Old saved practice state is ignored. Display preferences and the intro-seen flag
can still survive reloads.
Shiki, SQLite, and Git never ship to the browser. Run `bun run gen:demo` after
editing canned content; generated fixtures are excluded from Biome.

Explicit Submit schedules the scripted agent, claims notes, publishes a new
version, comments with context, and leaves status for the human. Selection stays on
the original version. Archive prevents publication and re-registration and
rejects in-flight comments while retaining pending work. The demo implements the
public contract directly; its temporary state is separate from wire types.

The build replaces only the default renderer used by `ArtifactView`. The demo
renders immutable build fixtures in `srcdoc` iframes with `sandbox="allow-scripts"`
and no same-origin privilege. Artifact/version/hash/path identity must match a
bundled publication; localStorage cannot provide executable document or asset
bytes. CSS and images are embedded from the same bundle, and links resolve only
to that publication's documents and fragments. Query routes, external links,
arbitrary publication uploads, and the publisher utility/device API are outside this demo.
Comment paste/upload and crop use the shared image controls; message retry keys
last for the page visit and image reads verify membership in the selected artifact.

The shared selection/Locate runtime and Markdown theme/height adapters run on a
document-specific port exposing only preview UI events. Fragment evidence is
retained by a demo navigation adapter because srcdoc has no published URL. A
native document switch remounts the iframe, closing the previous port without
adding a preview entry to browser history. Loaded Markdown stays mounted across
file folding, matching the workspace's existing retained-preview behavior.

CSP restricts resource requests, but the demo has no daemon capability gate or
verified Connection Allowlist. Every preview explains that distinction. Do not
present it as production security or add a same-origin execution fallback.
`CAN_MANAGE_TOKENS=false` hides access management and sign-out, which have no
meaning in this tab.

### Public website integration

Keep website implementation under `site/`: content, HTML layouts, CSS, browser
scripts, media, demo customizations, build logic, and tests. Reuse dependencies
from the root package; Pagefind is a development dependency for static search.
Root TypeScript checking includes `site/`; the existing test and Biome commands
discover its files. Keep generated output under the ignored `dist/` directory.

Fieldwork PNG captures and the social preview PNG use Git LFS. Website builds
and capture verification require hydrated image bytes; follow `site/README.md`
for checkout setup. Keep LFS enabled in the CI build and Pages checkout steps.
Binary-only jobs do not need these website assets.

The Pages workflow uses `bun site/build.ts` when that entrypoint exists. This
single command owns the complete deployable output, including the demo:

- `R3_SITE_BASE` is the mount path from `configure-pages`, such as `/r3` or an
  empty string for a custom domain. Normalize it once for all site and demo URLs.
- `R3_SITE_URL` is the full public base URL, including the mount path, for
  canonical links, sitemap entries, and agent-readable links.
- Output goes to `dist/pages/`, including nonempty `index.html` and `404.html`.
  Rebuild from clean output so old assets cannot survive a new publication.
- The builder owns fixtures, assets, search, exports, and link validation. It can
  reuse `buildDemo({ directory, base, plugins })` from `scripts/build-demo.ts`;
  keep site-specific build plugins and demo overrides inside `site/`.
- Preserve demo deep-link reloads while providing a useful website 404. Pages
  honors only the site-root `404.html`; directory-level fallback files do not
  handle requests independently.

Before `site/build.ts` is added, Pages retains the demo-only build below. A present
website builder that fails must fail deployment, without falling back to the demo.
Both paths verify the output entrypoints before upload. CI runs a present website
builder with both a project mount and a root mount; it performs no deployment.
The workflow path filter includes website content and product sources used by
documentation and fixture generation. The compiled product build remains separate;
`site/` is outside the Nix binary's source fileset.

### Demo-only Pages layout

The fallback in `.github/workflows/pages.yml` builds the demo on push to `main`,
mounting it at `<base_path>/demo/`. A project page uses `/r3` as its base path;
a custom domain can use the root.

`R3_DEMO_BASE=<base_path>/demo` (base_path from `configure-pages`) bakes that prefix
into the router (`hrefFor`/`__R3_BASE__`) and asset `publicPath`. Then
`scripts/stage-pages.ts` lays out `dist/pages`:

- the build under `demo/`,
- a root→demo redirect,
- and — because **Pages honors only a single site-root `404.html`** (subdirectory
  ones are ignored) — the SPA copied to the site-root `404.html`, so a deep-link
  reload of `/r3/demo/artifact_x` still boots it (its asset URLs are absolute).

Local `build:demo` defaults to a root base, so `bunx serve -s dist/demo` just works.

## Nix

`toolchain/package.json` and its npm lockfile own the Bun, Biome and npm versions
and platform archive integrity. `nix/toolchain.nix` consumes these archives;
`.github/actions/setup-toolchain` consumes the same pins. Keep this package
separate from the application's empty `bun` override. Toolchain installs disable
lifecycle scripts; the Bun runtime comes from setup-bun or the Nix derivation,
not the npm wrapper. The Node engine pin must match `nodejs_24` in `flake.lock`;
Nix asserts that relationship when the snapshot changes. The bun2nix generator
in the root manifest must also match the flake's bun2nix consumer version.

Dependabot updates `/toolchain` weekly with the 21-day cooldown. For manual
updates use the pinned npm from `nix develop`, then run
`npm install --prefix toolchain --package-lock-only`; `toolchain/.npmrc` applies
the same minimum age. Keep the manifest and lockfile together. The Biome schema
uses the hosted URL in `biome.jsonc`, independently of the installed version.
`scripts/check-toolchain.ts` checks the running versions and all platform pins.

CI builds all four release targets and uses the same native verification as
releases. The existing `check` status aggregates those jobs and Linux/macOS Nix
builds, so a toolchain PR cannot pass on a Linux-only smoke check. Local compile
scripts reject a Bun version that differs from the shared pin: the compiler's
runtime is part of the shipped executable. Bun 1.3.13 produced an invalid final
page hash on macOS arm64; native signing also repairs the stale signature left
by Intel macOS cross-compilation.

`nix/r3.nix` drives the same `bun run build` with a custom `buildPhase` on top of
stdenv + the bun2nix hook (which installs the pinned deps from `bun.nix`) — the
compile step is more than bun2nix's default module→binary path. `bun.nix` is
generated from `bun.lock` and **committed**: any dependency change must regenerate
it in the same commit.
