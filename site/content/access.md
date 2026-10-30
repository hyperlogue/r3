<!-- visual: access -->

## On your machine

The local server starts automatically when needed. It listens only on this computer and needs no login by default, so artifact links open directly. The first time a browser opens it, r3 shows a one-time notice about this; `r3 config set disableLoginNotice true` turns it off.

Artifact links from `r3 create` and `r3 publish` are stable: you can read an agent's reply and open its link later. Share these ordinary URLs; local `r3 open` sign-in links are intended for immediate use.

### Turn on login for the local server

Without login, any program or user account on this computer that can reach the server's port can read every artifact and send comments to your coding agents. A tunnel or port forward such as `ssh -L` extends that access to other machines. The server refuses requests forwarded by an HTTP proxy and never creates login tokens or API keys in this mode.

To require login, run on this computer:

```sh
r3 config set requireLogin true
r3 server restart
```

Run `r3 open` and open the printed sign-in link within five minutes. It keeps your existing browser login. If you are signed out, it creates a normal persisted login token and session. The link ticket stays in memory; the resulting login survives server restart and follows the normal inactivity and session expiry policy. You can also create a login token with `r3 auth create-token --label browser`. `r3 config unset requireLogin` restores the default.

## Connect to a remote server

On the agent’s machine:

```sh
r3 config set backendUrl https://reviews.example
r3 login
```

Replace the example address with your server URL. Open the authorization URL in your browser, sign in if needed, check the confirmation code, and approve CLI access. Remote servers always require login, and the CLI needs this separate authorization. The CLI can use a localhost backend without saved credentials only when that backend has login disabled.

**Access applies to the entire workspace.** When login is required, sharing an artifact link does not sign the recipient in. When login is disabled, any client that can reach the server through an allowed hostname can access the workspace, including other users on the same machine. r3 does not provide per-artifact permissions or team roles.

## Host your own

To expose r3 over a private network or domain, place an HTTPS reverse proxy in front of the loopback server, forward all routes (including previews), and set `publicUrl`. An external hostname in `publicUrl` or `allowedHosts`, or any `trustedProxies`, turns login on, even if the proxy connects through localhost; the server refuses to start with `requireLogin=false`. Restart the server to apply configuration changes, then use `r3 auth create-token --label browser` for browser sign-in.

Login is off by default only with a loopback bind, loopback-only public URL and allowed hosts, and no trusted proxies; every other configuration requires it. Host/origin checks and preview isolation remain enforced in either mode. See [Configuration](/docs/configuration/) for overrides and [Troubleshooting](/docs/troubleshooting/) for sign-in problems. Run server and configuration commands directly on the server's machine.
