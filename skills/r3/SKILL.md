---
name: r3
description: Publish HTML pages, documents, files, or code changes to r3 for human review, and respond to feedback on existing r3 artifacts. Use when the user asks to use r3 or supplies an r3 artifact or feedback command.
---

# r3 — Render. Review. Refine.

Run r3 without a global installation or source checkout. Choose the runner for
the current system and read the agent guide once per session.

On NixOS (`ID=nixos` in `/etc/os-release`), prefer the repository's Nix flake:

```sh
nix run github:hyperlogue/r3#r3 -- guide
```

The flake currently supports `x86_64-linux` on NixOS and supplies a binary built
for its loader environment. This command follows the repository's default branch
and may build r3 on first use.

On other systems, use the latest published npm release with an available runner:

```sh
npx --yes @hyperlogue/r3@latest guide
```

With Bun:

```sh
bunx --bun @hyperlogue/r3@latest guide
```

The Bun command runs the package launcher with Bun, so Node is not required.
Keep using the chosen runner for subsequent commands. Wherever the guide,
notifications, or copied feedback commands say `r3`, substitute
`nix run github:hyperlogue/r3#r3 --`, `npx --yes @hyperlogue/r3@latest`, or
`bunx --bun @hyperlogue/r3@latest`, preserving the arguments, working directory,
and harness environment. Keep the `--` separator when using Nix. For example:

```sh
nix run github:hyperlogue/r3#r3 -- comment fetch <artifact-id>
```

Follow the executable's guide for publication and the feedback workflow. Before
preparing an artifact kind for the first time in a session, read its preparation
guide with the same runner: `guide html`, `guide files`, or `guide diff`.
Use `--help` for command details. These guides match the executable being run.

Complete the requested publication or feedback work and share the returned artifact
URL. Revisions belong to the existing artifact; the guide describes how to publish
a new version and reply to its threads.
