## Most workflows need zero configuration

r3 runs on loopback with login disabled by default. Ordinary artifact links work without tokens, sign-in tickets, or persistent browser-auth records. You can customize font sizes, color themes, and syntax styles directly in the workspace.

Choose **Settings → Language** for English or Simplified Chinese. The choice is
saved in your browser. Chinese interface text currently uses English placeholders.

To inspect current settings, run `r3 config show` in your terminal.

## Key configuration settings

| Setting | What it controls |
| --- | --- |
| `backendUrl` | The backend endpoint your CLI and agent connect to. |
| `publicUrl` | The server's public browser address; an external hostname enables login by default. |
| `allowedHosts` | Additional accepted hostnames; any external hostname enables login by default. |
| `trustedProxies` | Proxy connection IPs trusted to supply the client address; configuring a proxy enables login by default. |
| `requireLogin` | Explicitly require (`true`) or disable (`false`) browser and API authentication, overriding the automatic default. |
| `archiveTtlDays` | Minimum age before an archived artifact qualifies for cleanup (Default: 30 days). |
| `authTokenIdleDays` | Inactivity window before a browser login token expires (Default: 14 days). |
| `projectGrouping` | Automatic Git remote detection (`remote`) or explicit project assignment (`manual`). |

Server-level changes must be executed **on the host machine** and applied by running `r3 server restart`. (Updating `backendUrl` in the CLI takes effect immediately).

Use `r3 config set requireLogin true` to require login even on localhost, or `r3 config set requireLogin false` to disable server-side authentication even when external hostnames or proxies are configured. Use `r3 config unset requireLogin` to restore the automatic default: login is disabled for localhost-only configurations without trusted proxies and enabled when external hosts or trusted proxies are configured. Default local-only mode refuses forwarded requests; explicit `requireLogin` settings override that refusal too. `R3_REQUIRE_LOGIN`, when set, takes precedence over the saved setting.

With login disabled, anyone who can reach the server through an allowed hostname can access the whole workspace. Host/origin checks and preview isolation still apply. Publication URLs contain no expiring sign-in ticket in either mode. Remote CLI backends still need authorization through `r3 login`; see [Local & remote access](/docs/access/).

For remote server hosting and multi-device setups, see [Local & remote access](/docs/access/).
