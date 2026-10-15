## Most reviews need no setup

Use the workspace’s appearance controls for theme, text size, and source colors.

For server settings, ask your agent or administrator to run `r3 config show` and consult `r3 --help`.

## Settings you may want to change

| Setting | What it changes |
| --- | --- |
| `backendUrl` | Which server your agent connects to. |
| `archiveTtlDays` | How old an archive must be for manual cleanup. Default: 30 days. |
| `authTokenIdleDays` | Browser login-token inactivity limit. Default: 14 days. |
| `projectGrouping` | Automatic Git grouping or manual projects. |

Server settings must be changed **on the server’s machine**, then applied with `r3 server restart`. A changed `backendUrl` applies immediately.

For remote hosting and sign-in, follow [Local & remote access](/docs/access/).
