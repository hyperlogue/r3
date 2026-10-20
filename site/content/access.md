<!-- visual: access -->

## On your machine

Open the artifact link returned by your agent, or run `r3 open` and open the printed workspace address. The local server starts automatically when needed. A localhost-only setup requires no token, sign-in ticket, or browser session by default.

Artifact links from `r3 create` and `r3 publish` are stable: you can read an agent's reply and open its link later. If you explicitly enable login on the local server, `r3 open` can provide a one-time sign-in link for immediate use; that ticket expires after 60 seconds. Agents should share the ordinary artifact URL.

## Connect to a remote server

On the agent’s machine:

```sh
r3 config set backendUrl https://reviews.example
r3 login
```

Replace the example address with your server URL. Open the authorization URL in your browser, sign in if needed, check the confirmation code, and approve CLI access. Remote CLI backends require this authorization even when the server has `requireLogin=false`; the CLI only sends requests without saved credentials to localhost backends.

**Access applies to the entire workspace.** When login is required, sharing an artifact link does not sign the recipient in. When login is disabled, any client that can reach the server through an allowed hostname can access the workspace, including other users on the same machine. r3 does not provide per-artifact permissions or team roles.

## Host your own

To expose r3 over a private network or domain, place an HTTPS reverse proxy in front of the loopback server, forward all routes (including previews), and set `publicUrl`. Configuring an external hostname in `publicUrl` or `allowedHosts`, or adding `trustedProxies`, enables login by default, even if the proxy connects through localhost. The default local-only mode refuses forwarded requests. Restart the server to apply configuration changes, then use `r3 auth create-token --label browser` for browser sign-in.

An explicit `requireLogin=true` or `false` overrides the default. Host/origin checks and preview isolation remain enforced in either mode. See [Configuration](/docs/configuration/) for overrides and [Troubleshooting](/docs/troubleshooting/) for sign-in problems. Run server and configuration commands directly on the server's machine.
