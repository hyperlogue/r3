r3 runs locally by default. A server stores published content and conversations and serves the browser workspace. A separate notification worker on the agent’s machine carries comment notifications to local agent sessions.

## Use the local workspace

```sh
r3 start
r3 status
```

Use the URL printed by these commands. The default listener is on loopback. Local browser access works without login unless you enable it.

The server owns the stored publications. A publisher uploads captured content, so the server does not need the publisher’s repository, worktree, or original file paths.

## Expose a protected remote instance

Use an HTTPS reverse proxy or tunnel pointing to the loopback application listener. Forward the whole application, including `/__r3_preview/`, and set `X-Forwarded-Proto: https` at the proxy. Rendered previews use the browser’s r3 address; a separate preview port or wildcard domain is unnecessary.

Set the public URL and require login before exposing the instance. Replace the example with your own proxy address:

```sh
r3 config set publicUrl https://reviews.example
r3 config set requireLogin 1
r3 restart
r3 auth create-token --label browser
```

Use the generated token to sign in. Keep it private. Configure the proxy and host allowlist for the actual address instead of relaxing origin checks to fix a routing error.

## Understand the access boundary

r3 is a single-owner workspace. A valid login grants access to all artifacts on that instance; there are no per-artifact sharing permissions or separate team accounts. Sharing an artifact URL alone does not grant someone access to a protected instance.

Manage login tokens from the workspace or with `r3 auth`. Tokens and their browser sessions can be revoked. Tokens expire after 14 days without a successful login or authenticated cookie request by default. Never-used tokens age from their creation.

## Select a backend and sign in

To use a server from another machine, save its URL and authorize the CLI:

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

Every command, including `r3 comment fetch`, uses the selected backend. If an artifact cannot be found, check the backend choice; the CLI does not search other instances. Unset `backendUrl` and remove directory or environment overrides to return to automatic local mode.

## Manage client access

Browser login tokens and CLI authorizations are separate. Use `r3 auth create-key` to create a client API key, optionally with an expiry. `r3 auth list-clients` lists authorizations and `r3 auth revoke-client` revokes one. `r3 auth audit` shows recent authorization observations without secret values.

Browser-approved CLI access refreshes automatically when possible. If credentials expire or refresh cannot recover, run `r3 login` again for that backend. Authorizing a CLI is independent of the session identity used to attribute an agent’s comments.

## Inspect notification delivery

Publishing and comment fetch work the same locally and remotely. The CLI reads and writes directly to the backend. Supported local harnesses use the persistent worker to receive notifications through an outgoing connection; no inbound TCP port is opened on the publisher’s machine.

```sh
r3 worker status
```

Use this command to inspect backend connections and reported delivery problems. `r3 worker start|stop|restart` manages notification delivery; `r3 server start|stop|status|restart` manages the local storage server. The shorter `r3 start`, `stop`, `status`, and `restart` commands remain server aliases.

Agents without a supported notification adapter can use `r3 watch` or fetch comments on demand. See the [agent workflow](/docs/agents/) for subscription priority, reconnect behavior, and exit codes.
