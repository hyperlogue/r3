---
name: release
description: Cut an r3 release — draft the CHANGELOG entry, bump every version string in lockstep, commit, then cut the annotated `vX.Y.Z` tag whose message carries the changelog section (the release CI turns it into the GitHub release notes). Use when the user wants to release a new version, bump the version, write or update the changelog, or tag a release.
---

# Releasing r3

A release is one version-bump commit plus an annotated tag on it. The whole job
is: write the changelog, move **every** version string to the new number
together, commit, then tag with the changelog section as the tag message — the
release CI lifts that message into the GitHub release notes — and push.

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
   - Write from the **user's** vantage point: what they can now do, or no longer
     run into — not the internal mechanics, refactors, or scaffolding that got it
     there. Frame each entry as what *shipped*, not what was turned off or reworked
     mid-development; internal churn a user never observes doesn't belong in the
     log at all. Match the existing voice: a bold lead-in (`**Feature.**`) then a
     sentence or two on the change and why it matters; fold related commits into
     one bullet.
   - Add the compare link at the very bottom, with the others:
     `[X.Y.Z]: https://github.com/hyperlogue/r3/compare/v<prev>...vX.Y.Z`

   This entry is the release's public face — from step 6 it becomes the tag
   message and the GitHub release notes verbatim. **Show the draft to the user and
   get their sign-off before you commit.**

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

6. **Tag** — annotated, on the commit you just made, carrying the changelog
   section as the message **body** so the CI can lift it into the GitHub release
   notes (the `r3 vX.Y.Z` subject is the convention since v0.2.0). The awk pulls
   exactly the `## [X.Y.Z]` section (never a stray `[Unreleased]` or the previous
   release), minus its heading (the release title already shows the version), and
   the guard refuses to tag when that section is missing or empty. `--cleanup`
   matters: git's default mode strips `#`-prefixed lines as comments, which would
   silently delete every `### Added/Changed/Fixed` group heading from the tag —
   `whitespace` keeps them and still trims trailing blanks:
   ```sh
   V=X.Y.Z
   NOTES=$(awk -v v="$V" 'index($0, "## [" v "]")==1{f=1; next} /^## \[/{f=0} f' CHANGELOG.md | sed '/./,$!d')
   test -n "$NOTES" &&
     printf 'r3 v%s\n\n%s\n' "$V" "$NOTES" | git tag --cleanup=whitespace -a "v$V" -F - ||
     echo "refusing to tag: no populated '## [$V]' section in CHANGELOG.md" >&2
   ```
   Eyeball the message before pushing — the `###` group headings must have
   survived: `git tag -l --format='%(contents)' "v$V"`.

7. **Push** — leave the actual push to the user unless they ask, and note that
   this environment often has no push credentials (SSH key / `gh` auth may be
   absent — surface that instead of silently failing):
   ```sh
   git push origin main && git push origin vX.Y.Z
   ```

## After the tag lands on GitHub

The tag-driven pipeline (`.github/workflows/release.yml`) cross-compiles the four
`r3-<os>-<arch>` binaries + `SHA256SUMS` (GitHub Release: curl / Homebrew) and
publishes the npm launcher (`@hyperlogue/r3`) with its per-platform
optional-dependency packages. It fills the **release description from the tag
message body** — the changelog section from step 6 — falling back to GitHub's
auto-generated notes only if the tag carries none. The pins were already synced
in step 3, so there is nothing else to bump by hand.

## If you botch a release

**Immutable releases are enabled**, so a published `vX.Y.Z` tag can't be moved or
deleted through the normal path — which is the whole reason steps 1–6 get it right
the first time (bump before tag, changelog into the tag). Recovery depends on how
far it got:

- **Not pushed yet** — the tag is still local. Delete and recut it: `git tag -d
vX.Y.Z`, fix, then redo step 6. Cheap.
- **Already pushed / released** — don't fight the immutability. **Cut the next
  patch version** (`vX.Y.(Z+1)`) carrying the fix; that is the intended recovery.
  Force-moving a published tag is a rare escape hatch that needs the user to
  *temporarily* lift GitHub's immutable-tag / release protection, then `git tag -f
--cleanup=whitespace -a vX.Y.Z -F - <commit>` and `git push --force origin
vX.Y.Z`. It's
  outward-facing and hard to reverse — confirm with the user first, and if the
  branch and tag can't both push, stop and report rather than half-applying.

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
