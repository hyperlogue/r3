## Most workflows need zero configuration

r3 runs on loopback and needs no login by default, so ordinary artifact links open directly. You can customize font sizes, color themes, and syntax styles directly in the workspace.

Choose **Settings → Language** for English or Simplified Chinese. The choice is
saved in your browser.

To inspect current settings, run `r3 config show` in your terminal.

## Key configuration settings

| Setting | What it controls |
| --- | --- |
| `backendUrl` | The backend endpoint your CLI and agent connect to. |
| `publicUrl` | The server's public browser address; an external hostname requires login. |
| `allowedHosts` | Additional accepted hostnames; any external hostname requires login. |
| `trustedProxies` | Proxy connection IPs trusted to supply the client address; configuring a proxy requires login. |
| `requireLogin` | `true` requires browser and API authentication on a loopback-only server. Exposed servers always require it, and `false` is refused there. |
| `disableLoginNotice` | `true` hides the browser's one-time notice that a loopback server runs without login (Default: `false`). |
| `archiveTtlDays` | Minimum age before an archived artifact qualifies for cleanup (Default: 30 days). |
| `authTokenIdleDays` | Inactivity window before a browser login token expires (Default: 14 days). |
| `projectGrouping` | Automatic Git remote detection (`remote`) or explicit project assignment (`manual`). |

Server-level changes must be executed **on the host machine** and applied by running `r3 server restart`. (Updating `backendUrl` in the CLI takes effect immediately).

Login is off by default only for a server that this computer alone can reach: a loopback bind, loopback-only `publicUrl` and `allowedHosts`, and no `trustedProxies`. `r3 config set requireLogin true` turns it on there. Any other configuration always requires login; r3 refuses to save or start it with `requireLogin=false`. `r3 config unset requireLogin` restores the default. `R3_REQUIRE_LOGIN`, when set, takes precedence over the saved setting and follows the same rule.

With login off, any program or local account that can reach the loopback port can access the whole workspace, and the server refuses requests forwarded by a proxy. It also creates no login tokens or API keys, so none can outlive the setting. Host/origin checks and preview isolation still apply. Publication URLs contain no expiring sign-in ticket in either mode. Remote CLI backends always need authorization through `r3 login`; see [Local & remote access](/docs/access/).

For remote server hosting and multi-device setups, see [Local & remote access](/docs/access/).
