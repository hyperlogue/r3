---
name: r3
description: Publish HTML pages, documents, files, or code changes to r3 for human review, and respond to feedback on existing r3 artifacts. Use when the user asks to use r3 or supplies an r3 artifact or feedback command.
---

# r3 — Render. Review. Refine.

Use the latest published r3 executable through a package runner. No global r3
installation or source checkout is needed.

Read the agent guide once per session with an available runner:

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
`npx --yes @hyperlogue/r3@latest` or `bunx --bun @hyperlogue/r3@latest`, preserving
the arguments, working directory, and harness environment. For example:

```sh
npx --yes @hyperlogue/r3@latest comment fetch <artifact-id>
```

Follow the executable's guide for publication and the feedback workflow. Before
preparing an artifact kind for the first time in a session, read its preparation
guide with the same runner: `guide html`, `guide files`, or `guide diff`.
Use `--help` for command details. These guides match the executable being run.

Complete the requested publication or feedback work and share the returned artifact
URL. Revisions belong to the existing artifact; the guide describes how to publish
a new version and reply to its threads.
