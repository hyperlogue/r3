# @hyperlogue/r3

**Review. Revise. Resolve.** — a local-first review tool for AI-generated code and docs.

## Try it

```sh
bunx @hyperlogue/r3 create --working     # or: npx @hyperlogue/r3 create --working
```

This package is a tiny launcher. The native `r3` binary for your platform ships
as a per-platform **optional dependency** (`@hyperlogue/r3-darwin-arm64`,
`-linux-x64`, …), so your package manager installs only the one that matches your
OS/CPU — no download at run time, and `npx @hyperlogue/r3@x.y.z` deterministically
runs that version's binary. The launcher just resolves the installed binary and
execs it, forwarding argv, stdio, and the exit code.

The binary is fully self-contained (it embeds its runtime, deps, and web UI), so
`bunx` and `npx` behave identically.

## Supported platforms

macOS and Linux (glibc), `arm64` / `x64`. On anything else the launcher tells you
to [build from source](https://github.com/hyperlogue/r3).

If the launcher reports that the platform package "is not installed," it's almost
always a stale lockfile (a [known npm optional-dependencies
bug](https://github.com/npm/cli/issues/4828)) — remove `node_modules` and the
lockfile and reinstall, or grab a binary from
[GitHub Releases](https://github.com/hyperlogue/r3/releases).

For the full tool docs, see the [project README](https://github.com/hyperlogue/r3#readme).
