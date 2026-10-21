## Most workflows need zero configuration

r3 runs on loopback and requires login by default. Run `r3 open` to sign this browser in the first time, then open ordinary artifact links. You can customize font sizes, color themes, and syntax styles directly in the workspace.

Choose **Settings → Language** for English or Simplified Chinese. The choice is
saved in your browser.

To inspect current settings, run `r3 config show` in your terminal.

## Key configuration settings

| Setting | What it controls |
| --- | --- |
| `backendUrl` | The backend endpoint your CLI and agent connect to. |
| `publicUrl` | The server's public browser address; an external hostname requires login to stay enabled. |
| `allowedHosts` | Additional accepted hostnames; any external hostname requires login to stay enabled. |
| `trustedProxies` | Proxy connection IPs trusted to supply the client address; configuring a proxy requires login to stay enabled. |
| `requireLogin` | Require browser and API authentication by default; `false` is allowed only for loopback-only configurations without trusted proxies. |
| `archiveTtlDays` | Minimum age before an archived artifact qualifies for cleanup (Default: 30 days). |
| `authTokenIdleDays` | Inactivity window before a browser login token expires (Default: 14 days). |
| `projectGrouping` | Automatic Git remote detection (`remote`) or explicit project assignment (`manual`). |

Server-level changes must be executed **on the host machine** and applied by running `r3 server restart`. (Updating `backendUrl` in the CLI takes effect immediately).

Login is required by default. `r3 config set requireLogin false` disables it only for a server that this computer alone can reach: a loopback bind, loopback-only `publicUrl` and `allowedHosts`, and no `trustedProxies`. r3 refuses to save or start any other combination; `r3 config unset requireLogin` restores login. `R3_REQUIRE_LOGIN`, when set, takes precedence over the saved setting and follows the same rule.

With login disabled, any program or local account that can reach the loopback port can access the whole workspace, and the server refuses requests forwarded by a proxy. It also creates no login tokens or API keys, so none can outlive the setting. Host/origin checks and preview isolation still apply. Publication URLs contain no expiring sign-in ticket in either mode. Remote CLI backends always need authorization through `r3 login`; see [Local & remote access](/docs/access/).

For remote server hosting and multi-device setups, see [Local & remote access](/docs/access/).
