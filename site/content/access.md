r3 runs locally by default. A server stores published content and conversations and serves the browser workspace. A separate notification worker on the agent’s machine carries comment notifications to local agent sessions.

## Use the local workspace

```sh
r3 open
```

The local server starts when needed. `r3 open` prints a one-time sign-in link to open in your browser. The link expires after 60 seconds; run the command again if needed. Use `r3 open <artifact-id>` for a link directly to a review.

Browser access requires authentication even on your own machine. Once signed in, you can follow artifact links normally. The default server listener stays on loopback.

The server owns the stored publications. A publisher uploads captured content, so the server does not need the publisher’s repository, worktree, or original file paths.

## Expose a protected remote instance

Use an HTTPS reverse proxy or tunnel pointing to the loopback application listener. Forward the whole application, including `/__r3_preview/`, and have the proxy overwrite `X-Forwarded-Proto` with the original request scheme. Rendered previews use the browser’s r3 address; a separate preview port or wildcard domain is unnecessary.

On the machine running the server, configure its public URL and create a browser login token. Replace the example with your own HTTPS address:

```sh
r3 config set publicUrl https://reviews.example
r3 server restart
r3 auth create-token --label browser
```

Use the generated token to sign in at that URL. Keep it private. The configured public URL is accepted by the host guard; list any additional application hostnames in `allowedHosts`.

If you need the original client address in the authorization audit, configure `trustedProxies` with the immediate proxy’s address and make that proxy overwrite `X-Forwarded-For`. Do not trust client-supplied forwarding headers.

## Understand the access boundary

r3 is a single-owner workspace. A valid login grants access to all artifacts on that instance; there are no per-artifact sharing permissions or separate team accounts. Sharing an ordinary artifact URL alone does not grant access.

Manage login tokens from the workspace or with `r3 auth`. Tokens and their browser sessions can be revoked. Tokens expire after 14 days without a successful login or authenticated cookie request by default. Never-used tokens age from their creation.

## Select a backend and sign in

On each machine where your agent runs, save the server’s URL and authorize the CLI:

```sh
r3 config set backendUrl https://reviews.example
r3 login
```

Open the printed URL in your authenticated r3 browser, check the displayed code, and approve CLI access. Opening the URL alone does not grant access. For an API key, pipe the key from your secret manager to `r3 login --api-key-stdin`.

Each command chooses its backend in this order: `R3_URL`, the nearest project `.r3.json`, the user’s `backendUrl` setting, then automatic local mode. A project override contains only the URL:

```json
{ "backendUrl": "https://reviews.example" }
```

Credentials stay in private user configuration and are keyed by the complete normalized URL, including its port and base path. A remote address does not inherit another backend’s credentials. `R3_TOKEN` is not a client override.

Artifact and conversation commands, including `r3 comment fetch`, use the selected backend. If an artifact cannot be found, check the backend choice; the CLI does not search other instances. Unset `backendUrl` and remove directory or environment overrides to return to automatic local mode. Configuration, server lifecycle, and worker lifecycle commands always manage this machine.

## Manage client access

Browser login tokens and CLI authorizations are separate. Use `r3 auth create-key` to create a client API key, optionally with an expiry. `r3 auth list-clients` lists authorizations and `r3 auth revoke-client` revokes one. `r3 auth audit` shows recent authorization observations without secret values.

Browser-approved CLI access refreshes automatically when possible. If credentials expire or refresh cannot recover, run `r3 login` again for that backend. Authorizing a CLI is independent of the session identity used to attribute an agent’s comments.

## Inspect notification delivery

Publishing and comment fetch work the same locally and remotely. The CLI reads and writes directly to the backend. Supported local harnesses use the persistent worker to receive notifications through an outgoing connection; no inbound TCP port is opened on the publisher’s machine.

```sh
r3 worker status
```

Use this command to inspect backend connections and reported delivery problems. `r3 worker start|stop|restart` manages notification delivery; `r3 server start|stop|status|restart` manages the local storage server. The top-level `r3 start`, `r3 stop`, `r3 status`, and `r3 restart` aliases warn that they are deprecated and will be removed in a future release.

Subscriptions survive temporary disconnections and server restarts. The same worker reconnects without changing the selected agent. A failed send remains visible and requires another send or a direct comment fetch; there is no automatic resend to another agent. A fresh `r3 listen <artifact-id>` replaces the explicit subscription.

If worker startup warns about a sandbox, run `r3 worker restart` from a regular terminal outside that sandbox. The worker inherits the permissions of the process that starts it, so publication can succeed while notification delivery fails.

Agents without a supported notification adapter can use `r3 watch` or fetch comments on demand. See the [agent workflow](/docs/agents/) for subscription priority, reconnect behavior, and exit codes.
