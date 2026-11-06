# Working on r3

Code and executable tests are the source of truth. Keep human-facing documentation
on the public website, the getting-started README, and the CLI help and guides.
Remove internal design/reference documents and inline comments that repeat what
can be inferred from code. Retain only operational instructions or explanations
whose information cannot be recovered from the implementation or its checks.

Keep public website content, styles, build logic, tests, and demo customizations
under `site/`. Update `HELP` and `GUIDE` in `cli/artifact-help.ts` when public
commands, output, flags, or agent workflows change.

## Development

- Work directly on `main`.
- Do not read `.env`, `.envrc`, or `.env.*` files.
- Verification uses temporary storage, isolated XDG directories, fresh browser
  profiles, and controlled endpoints. Never open, migrate, restart, or modify the
  normal user server/database just to test a change.
- Browser acceptance uses an installed browser through `R3_TEST_BROWSER`; some
  scripts also need `R3_TEST_PLAYWRIGHT`. Device checks use fake devices and real
  browser permission denial/grant. Do not claim real-device coverage from an
  emulated viewport.
- Tests should prove meaningful state, timing, byte, migration, or security rules.
  Use component showcases and isolated browser acceptance for interface changes.
- Keep the three-week dependency cooldown; never lower it to install a package.

## Committing

Before committing, run `bun run typecheck`, `bun test`, and `biome check .`.
Format modified paths with `biome check --write <paths>`.

Use small, self-contained Conventional Commits with a subsystem scope and an
imperative subject of at most 72 characters, without a final period. Stage only
your own files by explicit path. Commit after the checks pass; leave `git push`
to the user. Preserve existing authorship metadata. Keep personal identifiers,
credentials, and home-directory paths out of tracked files and commit messages.

Implementation does not authorize a version bump, tag, release, or publication.
For an explicitly requested release, read
[the release skill](.claude/skills/release/SKILL.md).
