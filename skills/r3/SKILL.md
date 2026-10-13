---
name: r3
description: Publish HTML pages, documents, files, or code changes to r3 for human review, and respond to feedback on existing r3 artifacts. Use when the user asks to use r3 or supplies an r3 artifact or feedback command.
---

First run `r3 guide` to try the executable on `PATH` and read the agent guide
once per session. If it succeeds, keep using that executable.

If `r3` is unavailable, run the latest published release with npm:

```sh
npx --yes @hyperlogue/r3@latest guide
```

With Bun:

```sh
bunx --bun @hyperlogue/r3@latest guide
```

On NixOS, use the Nix flake:

```sh
nix run github:hyperlogue/r3#r3 -- guide
```

Follow the executable's guide for publication and the feedback workflow. Before
preparing an artifact kind for the first time in a session, read its preparation
guide using the `guide html`, `guide files`, or `guide diff` subcommand.
Use `--help` for command details.

Complete the requested publication or feedback work and share the returned artifact
URL. Revisions belong to the existing artifact; the guide describes how to publish
a new version and reply to its threads.
