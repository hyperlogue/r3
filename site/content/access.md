<!-- visual: access -->

## On your machine

The local server starts automatically when needed and requires login by default. Run `r3 open` and open the printed one-time link to sign this browser in; the link expires after 60 seconds, and the browser session lasts while you keep using it.

Artifact links from `r3 create` and `r3 publish` are stable: you can read an agent's reply and open its link later in a signed-in browser. Agents should share the ordinary artifact URL, not an `r3 open` link.

If only this computer can reach the server, `r3 config set requireLogin false` turns login off. r3 then refuses requests forwarded by a proxy, and it will not start with login off while any external access is configured.

## Connect to a remote server

On the agent’s machine:

```sh
r3 config set backendUrl https://reviews.example
r3 login
```

Replace the example address with your server URL. Open the authorization URL in your browser, sign in if needed, check the confirmation code, and approve CLI access. Remote servers require login, and the CLI needs this separate authorization. The CLI can use a localhost backend without saved credentials only when that backend has login disabled.

**Access applies to the entire workspace.** When login is required, sharing an artifact link does not sign the recipient in. When login is disabled, any client that can reach the server through an allowed hostname can access the workspace, including other users on the same machine. r3 does not provide per-artifact permissions or team roles.

## Host your own

To expose r3 over a private network or domain, place an HTTPS reverse proxy in front of the loopback server, forward all routes (including previews), and set `publicUrl`. Keep login enabled, even if the proxy connects through localhost. An external hostname in `publicUrl` or `allowedHosts`, or any `trustedProxies`, prevents the server from starting with login disabled. No-login mode also refuses forwarded requests. Restart the server to apply configuration changes, then use `r3 auth create-token --label browser` for browser sign-in.

Login is required by default. An explicit `requireLogin=false` is allowed only with a loopback bind, loopback-only public URL and allowed hosts, and no trusted proxies. Host/origin checks and preview isolation remain enforced in either mode. See [Configuration](/docs/configuration/) for overrides and [Troubleshooting](/docs/troubleshooting/) for sign-in problems. Run server and configuration commands directly on the server's machine.
