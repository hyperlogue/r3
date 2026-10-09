# Remote backend protocol, version 2

The bundled r3 backend serves one human user. Third-party backends may serve several;
the CLI and notification worker treat authorization as opaque and leave user identity,
workspace scope, and access policy to the backend. The backend owns artifact bytes,
conversations, browser rendering, authentication, and subscription selection. The CLI uploads and reads
directly. A persistent worker delivers wake notifications to local harnesses.
Local mode uses these same contracts with an automatically started loopback server.
The [glossary](../../CONTEXT.md) defines backend, server, notification worker,
subscription, and selected subscription. The existing wire spellings
`registration`, `registered`, and `registrationId` still refer to subscriptions;
the terminology review does not rename protocol fields.

```text
CLI ───────── authenticated HTTP/JSON ─────── backend ← browser
 │                                               │
 private Unix socket                    outbound authenticated SSE
 │                                               │
 worker ←────────────────────────────────────────┘
 │
 local harness
```

This document defines the language-neutral extension to `artifacts-v2`.
`GET /api/health` advertises `r3-worker-v2`, `r3-auth-v1`, and `publication-url`
in its `capabilities` array. JSON uses UTF-8, camelCase names, and opaque string
identifiers. Unknown identifiers never imply a path or executable. Existing artifact
routes, immutable versions, discussions acknowledgment, and watch exit codes retain
their contracts in the [API reference](../../.claude/skills/api-surface/SKILL.md).

## Backend selection and transport

Every CLI invocation resolves one backend, in order:

1. Nonblank `R3_URL`.
2. The nearest `.r3.json`, searching from the working directory through the Git
   root (or filesystem root outside Git). The file contains only `backendUrl`.
3. `backendUrl` in the user's r3 `config.json`.
4. The lazily started local server.

Malformed selected configuration is an error. Commands never search other backends
for a missing artifact. Discussion fetch, source, and image reads have no backend
argument. A project file can be committed; it contains a URL, never credentials.

Backend identity is the complete normalized URL, including port and base path.
Normalization uses standard URL parsing, removes trailing slashes, and rejects
userinfo, query, fragment, encoded path separators, and non-HTTP schemes. HTTPS is
required except on loopback. The CLI rejects redirects, including same-origin
redirects. Bundled server deployments expose the application at the origin root;
alternative backends can use an API base path and return their own display URLs.

Private per-backend credentials live under `$XDG_CONFIG_HOME/r3/credentials/`
(default `~/.config/r3/credentials/`), keyed by a hash of that complete URL.
Directories are owned and mode 0700; files are mode 0600 and atomically replaced
with fsync. Processes coordinate refresh and replacement with a private lock.
Every request rereads current credentials. An explicitly configured URL never
inherits a different backend's credentials. `R3_TOKEN` is not a client override.
Automatic local discovery saves its matching local credential without a login step.

## Client authorization

Ordinary API and stream requests accept an API key or OAuth access token in
`Authorization: Bearer` or `X-R3-Token`. Browser cookies retain the existing
single-owner login model. Sessions used for authorship are not credentials.
All API routes retain Host and Origin checks, including the public OAuth routes;
opaque preview origins cannot authorize requests. Responses are `no-store`.

`r3 login --api-key-stdin` verifies and privately saves a supplied key. Keys can be
created, listed, and revoked with `r3 auth create-key`, `list-clients`, and
`revoke-client`. Keys optionally expire. No external identity provider is involved.

`r3 login` uses the [OAuth device authorization grant](https://www.rfc-editor.org/rfc/rfc8628):

| Route | Request | Response |
| --- | --- | --- |
| `POST /api/oauth/device/code` | Form: `client_id=r3-cli`, optional `label` | `device_code`, `user_code`, `verification_uri`, `verification_uri_complete`, `expires_in`, `interval` |
| `POST /api/oauth/token` | Form: `client_id=r3-cli`, device grant `grant_type=urn:ietf:params:oauth:grant-type:device_code`, `device_code` | `access_token`, `refresh_token`, `token_type=Bearer`, `expires_in` |
| `POST /api/oauth/token` | Form: `client_id=r3-cli`, `grant_type=refresh_token`, `refresh_token` | A fresh access token and rotated refresh token |
| `POST /api/oauth/device/inspect` | JSON: `userCode` | `label`, `expiresAt`, `requestIp` |
| `POST /api/oauth/device/decision` | JSON: `userCode`, boolean `approved` | `{ "ok": true }` |

The first two routes require no prior credential. Approval requires an authenticated
r3 browser session when login is enabled; an API key cannot approve another device.
`/authorize` shows the code and observed request address, then requires an explicit
Approve or Decline action. Merely opening the link does not grant access.

Device grants expire after ten minutes and are consumed once. Polls start at five
seconds; an early poll receives `slow_down` and adds five seconds to the interval.
Other OAuth errors include `authorization_pending`, `access_denied`, `expired_token`,
`invalid_grant`, and `unsupported_grant_type`, with HTTP 400. Forms are limited to
8 KiB, reject duplicate fields, and accept only the public `r3-cli` client. The
server limits authorization requests per observed source to 60/minute, with at most
256 active device flows and a bounded source-rate map. Capacity failures return 429.

Access tokens last 15 minutes; refresh tokens expire after 90 days unused and
rotate on every refresh. Reuse revokes the authorization and closes its worker
connections, following [OAuth security guidance](https://www.rfc-editor.org/rfc/rfc9700).
Refresh is serialized across CLI processes and worker; a process rereads the file
after acquiring its lock. A failed refresh or lost refresh response may require
`r3 login` again. A 401 pauses only the affected worker backend until successful
login reloads it. Temporary transport/server failures retry with bounded backoff.

Management routes require ordinary authentication:

| Route | Contract |
| --- | --- |
| `GET /api/auth/clients` | Authorization IDs, kind, label, creation, expiry and revocation timestamps; no secret hashes |
| `POST /api/auth/clients` | Optional `label`, optional future `expiresAt` in epoch milliseconds; returns `id`, one-time `token`, `expiresAt` |
| `DELETE /api/auth/clients/:id` | Revoke that authorization and close its worker connections |
| `GET /api/auth/audit` | Latest 1,000 observations, newest first |

The approval transaction records server time and separate observed CLI and browser
source addresses before any token is issued. The worker address is initially null;
its later connection appends a `worker-connected` observation for the authorization.
The server uses the actual connection peer. Only an explicitly configured immediate
`trustedProxies` peer may supply one valid `X-Forwarded-For` address; chains are not
guessed. A trusted proxy must overwrite the header. Audit data contains no bearer,
refresh, device, cookie, or harness secrets. Addresses are observations, not identity.

## Worker connection

One worker serves all configured backends independently. It opens no TCP listener,
reads no artifact database, and caches no artifact/discussions content. Its private
Unix socket passes local setup information only. HTTP watch and all data reads
remain between CLI and backend.

The worker persists a random worker ID, backend-qualified opaque listener IDs,
and local harness targets in
`$XDG_STATE_HOME/r3/worker-state.json` (default `~/.local/state/r3/`). The local IPC
socket and discovery file reside beside `daemon.json` in the runtime directory.
Authenticated IPC, rather than a PID check, establishes that an existing worker is
alive, including across PID namespaces. The IPC file and socket require owner-only permissions and a separate private
credential; requests carrying any Origin header are rejected. Paths, executables,
Codex home, Claude sockets, and harness credentials never enter backend requests.

`POST /api/workers/connect` accepts `workerId` and `protocol: "r3-worker-v2"`.
It returns `text/event-stream`; the first frame is `ready` with `protocol` and
`connectionId`. A new connection for the same worker and credential principal closes the previous one.
The backend retains each subscription with that principal; a different grant cannot
attach to it by supplying the same worker ID. After ready, the backend sends registered
frames for its retained subscriptions. Reconnection changes transport, not selection.
The credential principal that created a connection must authorize subsequent
requests addressed to it. Browser cookies alone cannot create a worker connection.
The bundled server caps simultaneous worker connections at 128.

SSE frames contain a JSON `data` object whose `type` matches the event name:

| Type | Fields and meaning |
| --- | --- |
| `ready` | `protocol`, opaque `connectionId` |
| `heartbeat` | Liveness only; sent every ten seconds |
| `registered` | `subscription` and public `registration` watcher snapshot |
| `retired` | `registrationId`, `reason`; discard that stream’s routing snapshot |
| `nudge` | `registrationId`, `listenerId`, `nudge` |
| `closed` | `reason`; reconnect transport when eligible; retain backend subscription selection |

No SSE replay cursor or offline notification queue exists. The worker aborts a
silent stream after 35 seconds, retries from 500 ms up to 30 seconds, and refreshes
credentials before reconnecting. The server closes expired/revoked authorization
streams while retaining their subscriptions and exposing a disconnected/error state.
A stale connection or acknowledgment cannot remove a newer subscription. The browser
shows the selected subscription’s connectionState and error from the watchers response.

The wire type `WorkerSubscription` carries a registration. Its `id` identifies
that registration, `listenerId` identifies the notification destination, and
`actor` identifies the authored agent session. Connections use separate `workerId`
and `connectionId` fields for the persistent worker and one live connection.
None of these identifiers is a client authorization or proof that an agent is
running. Existing field and route names retain their wire spellings.

A registration has these fields:

| Field | Type |
| --- | --- |
| `id` | Opaque registration ID, unique across its lifetime |
| `artifactId` | Existing active artifact ID |
| `listenerId` | Opaque local destination ID, scoped to this backend |
| `actor` | `{ role: "agent", sessionId: string }`, an existing attribution session |
| `mode` | `fallback` or `explicit` |

The actor and listener ID are distinct. The backend stores the listener ID verbatim
and routes it only through its current owning connection. It cannot interpret it
as a local harness address. Reusing a registration ID with different contents fails.

| Route | JSON body / effect |
| --- | --- |
| `POST /api/workers/:connectionId/targets` | `actor`, `listenerId`; bind an opaque destination on this connection (limit 4,096) |
| `POST /api/workers/:connectionId/listen` | An `explicit` subscription; replace the explicit slot |
| `POST /api/workers/:connectionId/acknowledgments` | `nudgeId`, `ok`, optional `state: sent|queued`; settle the active delivery attempt |

The CLI saves its local harness destination with the worker, then registers directly
with the backend. A successful publication returns its confirmed fallback subscription.
The worker keeps registered frames only as an in-memory validation map for that stream;
it persists no subscription intent. A CLI never proxies artifact operations through it.

## Selection, connection, and delivery

An artifact can retain one publisher fallback and one explicit subscription, with
at most one selected subscription. Explicit takes precedence. A committed publication
replaces the fallback even while an explicit subscription is selected; disabled or
unsupported publication clears it. Publication replay changes neither slot. Fresh
listen, fetch-listen, and watch replace only the explicit slot. Unlisten ends both
roles belonging to that caller. A generic watch still lasts only for its HTTP request.

Losing a worker connection leaves both backend subscriptions intact. The selected
subscription becomes disconnected, and Send to agent reports failure immediately;
there is no offline delivery queue or automatic resend. The same worker and credential
can reconnect and use the retained subscriptions without any resume request or
competition for a vacant slot. A new agent’s explicit listen replaces the old slot;
reconnecting the older worker never takes it back. A local delivery failure also
retains selection, records a visible error, and never retries on another recipient.
A later successful send clears that error. Manual listen from the same agent refreshes
its local connection information, while listening from another agent changes selection.

The backend persists subscription identity, worker identity, and authorizing principal.
Backend restart reconstructs retained selection as disconnected until transport returns.
Replacement, unlisten, archive, and deletion end subscriptions permanently. Restore
never revives pre-archive subscriptions. Worker state version 2 retains local destinations
but discards old recovery intents. Schema 12 retires older subscription records whose
credential principal was not saved; those require a fresh listen or publication after
upgrade. Local legacy destinations can still be imported without recreating subscriptions.

A watcher may include `connectionState: connected|disconnected|failed` and nullable
`error`. Error text describes backend delivery state and contains no local harness
paths or credentials. The browser presents it beside the selected subscription;
CLI data reads remain independent of worker health.

A nudge contains `id`, `artifactId`, nullable `title`, `event: submitted|archived`,
nullable `lifecycleEventId`, and nullable `message`. The worker validates the
backend-qualified listener/registration/artifact mapping before invoking its local
adapter. Unknown IDs return failed acknowledgment. Delivery is ordered per local
destination; separate destinations/backends do not block each other. At most six
notifications, including the active one, are queued per destination. The 15-second
acknowledgment deadline starts at dispatch, and disconnect rejects queued work.

Only the human's Send to agent action submits discussions. Setup, reconnect and
fallback selection never send pending content. Existing lifecycle rules still
allow an explicit nonblank archive message to reach the captured recipient after
archive commits. Delivery failure is reported to the human. `queued` means Codex
accepted the wake, not that a session is running. A nudge acknowledgment never
consumes discussions; snapshot fetch/output/acknowledgment remains a separate protocol.

## Publication response and compatibility checks

A successful `POST /api/artifacts/:id/versions` returns the version fields plus
`url`, the complete backend-owned artifact page URL, `listenerRegistered`, and an
optional `listener` subscription. The CLI prints `url` unchanged in text and JSON.
It does not infer a display route from the API base or artifact ID. Replay returns
the publication without reestablishing a fallback.

`cli/worker-protocol-fixture.ts` implements an independent HTTP/SSE fixture without
importing r3 server, storage, or shared wire types. Worker tests exercise it across
two backends, unknown destinations, retained subscriptions, reconnect, and credential reload.
`cli/publication-url.test.ts` separately proves an unrelated backend display route
survives both output formats. See [verification](verification.md) for security,
process, migration, browser approval, and compiled-binary checks.
