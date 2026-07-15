---
name: release
description: Cut an r3 release — draft the CHANGELOG entry, bump every version string in lockstep, commit, and create the annotated `vX.Y.Z` tag. Use when the user wants to release a new version, bump the version, write or update the changelog, or (re-)tag a release.
---

# Releasing r3

A release is one version-bump commit plus an annotated tag on it. The whole job
is: write the changelog, move **every** version string to the new number
together, commit, tag, push.

## The one rule: bump *before* you tag

The tag must point at the version-bump commit. Cutting the tag first and bumping
afterward leaves the tag on a commit whose in-code version is still the previous
release — this skill exists because that exact mistake happened once. Do the
changelog **and** the version bump in the release commit, then tag that commit.

## Version sources — all must read the same number

Three files hold the version. The release-build scripts
(`scripts/release-binaries.ts`, `scripts/stage-npm-packages.ts`) refuse to build
if they drift, so keep them in lockstep:

1. **`shared/version.ts`** — `R3_VERSION` (baked into the binary + CLI, reported
   by `/api/health`; the CLI warns on skew).
2. **`package.json`** — top-level `"version"`.
3. **`npm/package.json`** — `"version"` **and** all four `optionalDependencies`
   pins: `@hyperlogue/r3-darwin-arm64`, `-darwin-x64`, `-linux-x64`,
   `-linux-arm64`. All four must equal the new version (the launcher resolves the
   matching per-platform binary at exactly its own version).

## Steps

1. **Pick the version** (SemVer). Previous tag: `git describe --tags --abbrev=0`.

2. **Draft the CHANGELOG entry** (`CHANGELOG.md`, [Keep a Changelog] format).
   Survey what shipped since the last tag — `git log v<prev>..HEAD --oneline` —
   then:
   - Insert a new `## [X.Y.Z] - YYYY-MM-DD` section directly under the intro
     block, above the previous version. Use the release date.
   - Group bullets under `### Added` / `### Changed` / `### Fixed` / `### Removed`
     — only the groups that apply, in that order.
   - Write for **users**, not as diff narration. Match the existing voice: a bold
     lead-in (`**Feature.**`) then a sentence or two of what changed and why it
     matters. Fold several related commits into one bullet.
   - Add the compare link at the very bottom, with the others:
     `[X.Y.Z]: https://github.com/hyperlogue/r3/compare/v<prev>...vX.Y.Z`

3. **Bump all three version sources** to `X.Y.Z` — do not forget the four npm
   pins in `npm/package.json`.

4. **Verify they agree, then run the checks:**
   ```sh
   grep -rn '"version"\|R3_VERSION\|@hyperlogue/r3-' \
     package.json npm/package.json shared/version.ts   # every hit must read X.Y.Z
   bun run typecheck
   biome check .
   ```

5. **Commit** — Conventional Commit, and keep the `Co-Authored-By: Claude …`
   trailer (this repo uses it; see `AGENTS.md`):
   ```sh
   git add CHANGELOG.md shared/version.ts package.json npm/package.json
   git commit -m "chore: release vX.Y.Z"
   ```

6. **Tag** — annotated, message `r3 vX.Y.Z` (the convention since v0.2.0), on the
   commit you just made:
   ```sh
   git tag -a vX.Y.Z -m "r3 vX.Y.Z"
   ```

7. **Push** — leave the actual push to the user unless they ask, and note that
   this environment often has no push credentials (SSH key / `gh` auth may be
   absent — surface that instead of silently failing):
   ```sh
   git push origin main && git push origin vX.Y.Z
   ```

## After the tag lands on GitHub

The tag-driven pipeline cross-compiles the four `r3-<os>-<arch>` binaries +
`SHA256SUMS` (GitHub Release: curl / Homebrew) and publishes the npm launcher
(`@hyperlogue/r3`) with its per-platform optional-dependency packages. The pins
were already synced in step 3, so there is nothing else to bump by hand.

## Re-tagging a botched release

If a tag was cut on the wrong commit (e.g. before the version bump): make the
fix, commit it, then move the tag onto the corrected commit:

```sh
git tag -f -a vX.Y.Z -m "r3 vX.Y.Z" <commit>
git push --force origin vX.Y.Z
```

Force-pushing a moved tag **overwrites a published tag** and requires disabling
GitHub's immutable-tag / release protection first. It is outward-facing and hard
to reverse — confirm with the user before pushing, and if the branch commit and
the tag can't both push (e.g. protection still on), stop and report rather than
half-applying.

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
