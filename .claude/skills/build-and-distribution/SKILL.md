---
name: build-and-distribution
description: How r3 is built and shipped — the single-file Bun.build --compile binary and its browser-target Tailwind CSS pre-pass, the two release channels (GitHub Releases + the npm launcher with per-platform optional-dependency packages), the `bun` → empty-npm-package override, and the frontend-only browser demo deployed to GitHub Pages. Use when touching scripts/ (compile, spa-css, release-binaries, stage-npm-packages, wait-for-npm-packages, build-demo, stage-pages, gen-artifact-demo), npm/, web/demo/, bunfig.toml, the nix build, the Pages or release workflows, or debugging a broken binary/demo build.
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
register `release.yml` on it. Requires npm ≥ 11.5.1, which is why the npm
jobs upgrade npm and omit setup-node's `registry-url` (its `.npmrc`
placeholder token would shadow OIDC).

### Five jobs, and the approval gate

`release.yml` is **verify → build → publish → publish-platforms →
publish-launcher**. **Re-run failed jobs** resumes one stage. A successful
GitHub Release job is not run again.

That split is load-bearing. Immutable releases reject a re-upload, and that
rejection used to fail the single publish job before its npm steps — the
retry had been started because npm failed. The upload fallback in `publish`
only covers a full re-run. An npm retry must not enter `gh release upload`.

- **`verify`** checks the tag *shape* (plain SemVer — a git ref may contain
  `$( )`, backticks and `;`, so an unvalidated tag reaching a `run:` block is an
  injection vector) and the tag ↔ `npm/package.json` lockstep, then exports the
  verified version. Seconds, before a runner cross-compiles. A missing
  `## [X.Y.Z]` changelog section only **warns** — the release degrades to
  `--generate-notes`, and a prerelease tag legitimately has no section.
- **`build`** compiles (or, on a re-run, re-downloads and digest-verifies this
  tag's existing assets), execs the linux-x64 binary as a smoke test, and hands
  `dist/r3-*` to `publish` as an artifact. It can only read. The npm jobs do
  not use that artifact.
- **`publish`** creates the GitHub Release. `contents: write`, no npm credential.
- **`publish-platforms`** downloads those published assets, stages the four
  platform packages, and publishes them. `id-token: write`.
- **`publish-launcher`** downloads the same assets, stages again so the launcher
  pins come from that staging, waits until every exact pin is visible, then
  publishes `@hyperlogue/r3`. `id-token: write`.

Every publication job uses **`environment: release`**. GitHub asks for that
environment once per job, so a release asks three times. That is required:
each package's trusted publisher names the `release` environment, so the job
that runs `npm publish` must too, and folding those publishes into `publish`
makes an npm retry re-upload the immutable release. Configure the
environment's required reviewers (GitHub creates it implicitly, so the workflow
runs ungated until you do) plus a tag ruleset on `v*`. This matters because **a
tag push bypasses branch protection**: without the gate, anyone with write
access could tag an arbitrary commit straight into a signed npm publish.

The npm jobs stage the **published GitHub assets**, not the workflow artifact,
so a retry ships those bytes even when a full rerun rebuilt different binaries.
An npm version already on the registry is skipped.

`scripts/wait-for-npm-packages.sh` gives the launcher one ten-minute deadline
for every exact platform pin. Each poll revalidates npm metadata
(`--prefer-online`) and bounds the registry request, so a stall cannot outlive
the deadline. The old per-package 30×5s loop was shorter than registry lag.
Run `bun test scripts/wait-for-npm-packages.test.mjs` when changing that
wait. CI runs the same command. A bare `bun test` does not discover `.mjs`.

Two consequences worth keeping: the workflow-level default is `contents: read`
(only `publish` raises it; only the npm jobs hold `id-token: write`), and **no
publication job execs a release binary**. `publish-platforms` only stats the
staged exec bit. `build` already ran the one natively-runnable target, and
exec'ing an unverified artifact in a job that can mint a publish credential
would let a poisoned binary rewrite the other platform packages first. The
build artifact's `retention-days: 7` bounds how long the first approval may
idle. Past that, re-run the workflow so `build` can compile again. Once the
GitHub Release exists, an npm retry does not need the artifact.

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
and lifecycle in browser storage. An async event stream invalidates the same
queries as production. There is no global EventSource or fetch shim.

`scripts/gen-artifact-demo.ts` → `web/demo/artifact-fixtures.gen.ts` bakes two
public demo artifacts: an interactive HTML curve lab and a six-file diff review.
The curve lab embeds `samples/curve-lab.js` inline, with no external chart library;
its sliders update the approximation, residual plot, and sampled error metrics.
The generated workshop seed also retains the Files example for Storybook and the
tutorial. Complete versions, original bytes, retained Markdown HTML, theme palettes,
and scripted follow-up publications share the same generator. Preview documents
are a separate generated export; they are not restored from browser storage.
This gallery uses the `r3-artifact-demo-curves` storage key so returning visitors
start with the current examples; the previous practice state is left untouched.
Shiki, SQLite, and Git never ship to the browser. Run `bun run gen:demo` after
editing canned content; generated fixtures are excluded from Biome.

Explicit Submit schedules the scripted agent, claims notes, publishes a new
version, replies with context, and leaves status for the human. Selection stays on
the original version. Archive prevents publication and re-registration while
allowing in-flight replies and retaining pending work. The demo implements the
public contract directly; its persistence model is separate from wire types.

The build replaces only the default renderer used by `ArtifactView`. The demo
renders immutable build fixtures in `srcdoc` iframes with `sandbox="allow-scripts"`
and no same-origin privilege. Artifact/version/hash/path identity must match a
bundled publication; localStorage cannot provide executable document or asset
bytes. CSS and images are embedded from the same bundle, and links resolve only
to that publication's documents and fragments. Query routes, external links,
arbitrary uploads, and the publisher utility/device API are outside this demo.

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
  reload of `/r3/demo/artifact_x` still boots it (its asset URLs are absolute).

Local `build:demo` defaults to a root base, so `bunx serve -s dist/demo` just works.

## Nix

`nix/r3.nix` drives the same `bun run build` with a custom `buildPhase` on top of
stdenv + the bun2nix hook (which installs the pinned deps from `bun.nix`) — the
compile step is more than bun2nix's default module→binary path. `bun.nix` is
generated from `bun.lock` and **committed**: any dependency change must regenerate
it in the same commit.
