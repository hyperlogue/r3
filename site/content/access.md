<!-- visual: access -->

## On your machine

The local server starts automatically when needed. It listens only on this computer and needs no login by default, so artifact links open directly. The first time a browser opens it, r3 shows a one-time notice about this; `r3 config set disableLoginNotice true` turns it off.

Artifact links from `r3 create` and `r3 publish` are stable: you can read an agent's reply and open its link later. `r3 open [artifact-id]` prints the same ordinary URL without creating a login token or browser session.

### Turn on login for the local server

Without login, any program or user account on this computer that can reach the server's port can read every artifact and send comments to your coding agents. A tunnel or port forward such as `ssh -L` extends that access to other machines. The server refuses requests forwarded by an HTTP proxy and never creates login tokens or API keys in this mode.

To require login, run on this computer:

```sh
r3 config set requireLogin true
r3 server restart
```

Run `r3 auth create-token --label browser`, then `r3 open`. Open the printed URL and paste the token into the sign-in screen. Later opens use your existing browser session. `r3 config unset requireLogin` restores the default.

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
