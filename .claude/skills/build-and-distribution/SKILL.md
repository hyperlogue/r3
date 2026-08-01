---
name: build-and-distribution
description: How r3 is built and shipped — the single-file Bun.build --compile binary and its browser-target Tailwind CSS pre-pass, the two release channels (GitHub Releases + the npm launcher with per-platform optional-dependency packages), the `bun` → empty-npm-package override, and the frontend-only browser demo deployed to GitHub Pages. Use when touching scripts/ (compile, spa-css, release-binaries, stage-npm-packages, build-demo, stage-pages, gen-demo-fixtures), npm/, web/demo/, bunfig.toml, the nix build, the Pages or release workflows, or debugging a broken binary/demo build.
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
its own UI. The CLI **is** the binary; the hidden `__daemon` subcommand re-execs it
to serve.

**The CSS pre-pass is load-bearing.** The SPA stylesheet is Tailwind-compiled first
in a separate **browser-target** pass (`scripts/spa-css.ts`, shared with
`release-binaries.ts`). A compile build is `target:"bun"`, whose CSS printer keeps
Tailwind's native nesting verbatim — and un-lowered nesting breaks in browsers
(`& {…}` under `::placeholder` is unmatchable, so placeholders lose their dimming).
The pre-pass lowers it flat; the compile build embeds it as-is. Don't remove it.

## Two release channels, one tag-driven pipeline

`scripts/release-binaries.ts` cross-compiles the four `r3-<os>-<arch>` binaries +
`SHA256SUMS`. From there:

- **GitHub Releases** carry the raw assets (curl / Homebrew).
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
register `release.yml` on it. Requires npm ≥ 11.5.1, which is why the job upgrades
npm and omits setup-node's `registry-url` (its `.npmrc` placeholder token would
shadow OIDC).

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
its "backend" is an **in-browser store** (`web/demo/`) over `localStorage`.

It is the *same* `web/index.html` Bun.build, with:

- one `onResolve` plugin aliasing `web/src/{api.ts,demo-chrome.tsx,main.css}` to
  their `web/demo/` counterparts — so every fetch/SSE call hits the browser
  backend, the demo chrome replaces its production stub, and Tailwind also scans
  `web/demo`;
- an `EventSource` shim.

The demo reuses the server's genuinely **pure** modules verbatim (`anchor.ts`,
`textdiff.ts`, `prompt.ts`, `shared/types.ts`) and **pre-bakes** all Shiki/markdown
HTML at build time (`scripts/gen-demo-fixtures.ts` → `web/demo/fixtures.gen.ts`), so
**no highlighter, sqlite, or git ships to the browser**. Re-bake with `bun run
gen:demo` only after editing canned content.

The seed dogfoods r3 on its own code; a scripted agent watches each review and
closes the submit→reply→round loop. Reviews can't be *created* in the demo (no git)
— it's a read-and-respond tour of the seeded reviews.

**The demo must never fork the contract**: it implements `shared/types.ts`, it
doesn't extend it.

### The Pages layout

`.github/workflows/pages.yml` builds the demo and deploys on push to `main`,
mounting it at **`…/r3/demo/`** — the project page (`/r3/`, the repo name, forced by
Pages) plus a `/demo` sub-path.

`R3_DEMO_BASE=<base_path>/demo` (base_path from `configure-pages`) bakes that prefix
into the router (`hrefFor`/`__R3_BASE__`) and asset `publicPath`. Then
`scripts/stage-pages.ts` lays out `dist/pages`:

- the build under `demo/`,
- a root→demo redirect,
- and — because **Pages honors only a single site-root `404.html`** (subdirectory
  ones are ignored) — the SPA copied to the site-root `404.html`, so a deep-link
  reload of `/r3/demo/review_x` still boots it (its asset URLs are absolute).

Local `build:demo` defaults to a root base, so `bunx serve -s dist/demo` just works.

## Nix

`nix/r3.nix` drives the same `bun run build` with a custom `buildPhase` on top of
stdenv + the bun2nix hook (which installs the pinned deps from `bun.nix`) — the
compile step is more than bun2nix's default module→binary path. `bun.nix` is
generated from `bun.lock` and **committed**: any dependency change must regenerate
it in the same commit.

## Heritage

v1 was one server per repo with a gitignored per-repo `.r3/review.sqlite`; v2
replaced it with the one per-user daemon + global store. Some code comments still
cite the old model as history.
