# Workspace

Isolated, gitignored data dir for the `process-compose` dev stack (see
`../process-compose.yaml`).

The compose `server` process runs with `XDG_STATE_HOME`, `XDG_CONFIG_HOME`, and
`XDG_RUNTIME_DIR` pointed here. Its storage, configuration, and runtime files live
under `workspace/r3/`:

- `r3/r3.sqlite` and `r3/r3.sqlite.artifacts/blobs/` — artifact database and immutable content
- `r3/token` — the server's private API credential
- `r3/config.json` — this instance's saved configuration, when configured
- `r3/daemon.json`, `r3/daemon.lock` — server discovery and start lock

Application and previews share port 8891. To use this instance from the CLI, run
from the repository root with the same XDG directories:

```sh
XDG_STATE_HOME="$PWD/workspace" XDG_CONFIG_HOME="$PWD/workspace" \
  XDG_RUNTIME_DIR="$PWD/workspace" R3_PORT=8891 bun cli/index.ts list
```

An explicit backend override still takes precedence. Files here are **not
committed** but persist between sessions. Stop the development server and any
worker using these directories before deleting `r3/` to reset.
