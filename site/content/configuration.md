## Most workflows need zero configuration

By default, r3 runs automatically on loopback without manual configuration. You can customize font sizes, color themes, and syntax styles right inside the workspace.

To inspect current server configuration, run `r3 config show` in your terminal.

## Key configuration settings

| Setting | What it controls |
| --- | --- |
| `backendUrl` | The backend endpoint your CLI and agent connect to. |
| `archiveTtlDays` | Minimum age before an archived artifact qualifies for cleanup (Default: 30 days). |
| `authTokenIdleDays` | Inactivity window before a browser session token expires (Default: 14 days). |
| `projectGrouping` | Automatic Git remote detection (`remote`) or explicit project assignment (`manual`). |

Server-level changes must be executed **on the host machine** and applied by running `r3 server restart`. (Updating `backendUrl` in the CLI takes effect immediately).

For remote server hosting and multi-device setups, see [Local & remote access](/docs/access/).
