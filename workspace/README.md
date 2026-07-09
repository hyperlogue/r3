# Workspace

Isolated, gitignored data dir for the `process-compose` dev stack (see
`../process-compose.yaml`).

The compose `server` process runs with `XDG_STATE_HOME` and `XDG_RUNTIME_DIR`
pointed here, so its state lives under `workspace/r3/` instead of the real
`~/.local/state/r3`:

- `r3/r3.sqlite` — the global review store for this instance
- `r3/token` — the per-user API token
- `r3/daemon.json`, `r3/daemon.lock` — runtime discovery + start lock

Combined with the non-default port (`R3_PORT`), this keeps the compose instance
fully separate from any r3 daemon you run normally. Files here are **not
committed** but persist on disk between sessions; delete `r3/` to reset.
