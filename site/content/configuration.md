Use `r3 config` to inspect or change local server settings. Restart the local server after changing a setting that the server reads at startup.

```sh
r3 config show
r3 config get archiveTtlDays
r3 config set archiveTtlDays 30
r3 restart
```

`r3 config unset` removes a persisted override. Environment values take precedence over persisted configuration, then defaults apply. Configuration commands edit the local configuration even when `R3_URL` selects a remote server for other commands.

## Available settings

| Setting | Purpose |
| --- | --- |
| `backendUrl` | Default backend selected by the CLI, unless an environment or directory override takes priority. |
| `bind` | Application listener address; keep the default loopback binding for the documented proxy setup. |
| `port` | Application listener port. |
| `publicUrl` | Public application URL behind a proxy or tunnel. |
| `allowedHosts` | Explicit permitted application hostnames. |
| `requireLogin` | Require a browser login, including for local access. |
| `trustedProxies` | Comma-separated immediate proxy addresses permitted to report a client source address; configure only the proxy you operate. |
| `authTokenIdleDays` | Positive whole days of inactivity before a login token expires; default 14. |
| `archiveTtlDays` | Days since archive before manual cleanup eligibility; default 30, range 1–36,500. |
| `projectGrouping` | `remote` for inference from sanitized Git remotes, or `manual`. |
| `projectMappings` | JSON mapping remote URL aliases to existing project IDs. |

## Authentication lifetime

```sh
r3 config set authTokenIdleDays 30
r3 restart
```

Successful login or cookie-authenticated requests refresh token activity. Cookie activity is persisted in batches once a minute and at graceful shutdown. Expiry invalidates the associated browser sessions; startup removes inactive or revoked rows.

`R3_AUTH_TOKEN_IDLE_DAYS` overrides the setting. `r3 auth list-tokens --json` exposes each active token’s last-use timestamp without returning its secret value.

## Publisher environment

| Variable | Purpose |
| --- | --- |
| `R3_URL` | Select an explicit application server URL. |
| `R3_AGENT_SESSION` | Give a generic writing agent a distinct, stable run identity. |
| `R3_PROJECT_GROUPING` | Override the server’s project grouping policy. |

The nearest project `.r3.json` can select a `backendUrl` between the environment override and user default. This directory setting is separate from a Project group stored by the backend. Credentials come from `r3 login` and private per-backend storage, not `R3_TOKEN`.

Agent session identity is attribution, not a credential or artifact owner. The `--session` flag changes a readable display name; it does not establish a distinct identity. Each logical agent run should use its own identity.

See [Local & remote access](/docs/access/) for deployment setup and the [command reference](/docs/cli/) for exact syntax.
