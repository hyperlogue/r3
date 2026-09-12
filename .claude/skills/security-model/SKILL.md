---
name: security-model
description: r3's Host/origin/auth guards, isolated artifact preview and closed network policy, local and remote daemon configuration, publisher-side harness credentials, byte/path guards, migration storage, and dependency cooldown. Use when changing authentication, artifact or preview routes, resource serving, exposure settings, remote transport, or reviewing security impact.
---

# r3's security model

This file owns the security design. The daemon defends against browser-borne
attacks and casual remote access; executable artifacts also run behind a verified
closed network boundary. The product has one trusted human owner and multiple
logical agents, not multi-user accounts or per-agent permissions.

## Application boundary

`server/artifact-server.ts` binds the application and preview listeners separately,
only on loopback. All-interface binds are rejected. The application Host guard
runs before both API and static assets. Allowed application hosts are exact local,
explicitly allowlisted, or advertised public hostnames; never wildcards. Transport hostnames are not document identities: opaque preview documents
serialize their Origin as `null`, which the application guard rejects.

`server/artifact-auth.ts` gates every API request by full origin, including port.
A configured application origin supports a proxy that rewrites Host. Opaque preview origins must never enter that set. No-Origin CLI requests are allowed, but browser
cross-origin Fetch Metadata does not acquire that exemption. No cross-origin
access headers are emitted.

Every data route, including event streams, requires the master API token or a
valid browser cookie. Browser and agent streams use authenticated fetch, with no
token-free SSE exception. GET/HEAD health and same-origin boot, and POST login,
retain narrow bootstrap roles. Token comparisons are constant-time; reads carry
private cache policies. JSON bodies are bounded while streaming after auth.

Application resource downloads are attachments with restrictive CSP, `nosniff`,
no-referrer, and same-origin resource policy. Shell and assets are explicitly
served by `application-assets.ts`, with frame-ancestors none and X-Frame-Options
DENY. Missing asset paths return 404; only known artifact page routes get the shell.
Executable published HTML never runs on the application origin.

## Browser login and configuration

`AuthService` owns hashed login tokens and sessions on an injected SQLite connection.
Importing it opens no database. Revocation and session deletion are transactional;
migration preserves their existing records. A token is shown only when minted.

`REQUIRE_LOGIN` defaults on when publicUrl, allowedHosts, or bind config indicates
non-loopback access. A setting is policy, not proof of the network topology. On a
local no-login instance, boot supplies the master token to the same-origin browser.
With login required, boot exposes no master token: a revocable login token creates
an HttpOnly, SameSite=Strict cookie, Secure at an HTTPS edge. The proxy must set
X-Forwarded-Proto correctly. Individual revocation of the caller's current login
token is refused; revoke-all is the deliberate escape hatch.

A proxy that rewrites Host to loopback can conceal remote exposure. Set
`requireLogin` explicitly for such a deployment and advertise the application's
publicUrl. Never rely on the proxy being detectable. Remote publishing uses an
explicit R3_URL and R3_TOKEN; a different origin/path never inherits local discovery
credentials. Both clients and probes reject redirects when carrying credentials.

Settings resolve environment → `$XDG_CONFIG_HOME/r3/config.json` → defaults.
Configuration contains no secret. Supported settings include application bind,
port, publicUrl, allowedHosts and requireLogin, plus previewPort and previewBaseUrl.
Changes take effect at restart. The preview port defaults to application port + 1
and must differ from it. The local preview base is HTTP localhost; remote browser
rendering requires one HTTPS preview origin forwarded unchanged to the preview
listener. A second port on the same HTTPS hostname works without wildcard DNS. Never forward the application API
through that host, or merge the application and preview listeners/origins.

## Preview host

`server/preview-host.ts` serves one immutable version per temporary random path
under `/__r3_preview/<context>/`. Exact host/port and context membership are checked
before every response. Contexts expire after one hour without application renewal;
revocation or artifact deletion invalidates the whole context. These unguessable
URLs grant one version's resources, never application or other-artifact authority.
They are scoped bearer capabilities and must not be placed in logs or referrers.

Each document has `sandbox allow-scripts` in both the iframe and response CSP.
The browser assigns a fresh opaque origin on every navigation, even when two
previews share a transport hostname. The iframe is also credentialless, avoiding
ambient application cookies in transport requests. Persistent storage, workers,
nested frames, camera, and microphone are unavailable. Neither publisher scripts
nor a device grant can restore a real origin. Top-level published-document
navigation is refused; rendering belongs inside the workspace.

Before published bytes become available, a trusted gate verifies its opaque
origin, an allowed fetch, blocking of a working endpoint outside the allowlist,
and WebRTC rejection with no ICE servers and relay-only transport. Both fetch
probe endpoints permit credential-free CORS, so a CORS failure cannot stand in
for network enforcement. The gate HTML has no CORS headers: an unrelated opaque
document cannot read its single-use, two-minute challenge. JSON verification
accepts `Origin:null` only with that browser-bound challenge. Null is a serialized
origin, not an authentication principal. Grants use the browser's User-Agent;
opaque fetches omit client hints. No preview cookie is issued or accepted.
Browser identity alone never enables a context: the actual gate must pass first.

The Connection Allowlist includes only that context's `files/*` and `r3/*`, with
WebRTC and redirects blocked. CSP additionally restricts resource classes, forms,
frames, base URLs, and sandbox privileges. Service-worker script requests are refused;
CSP disallows ordinary and blob workers too. Unsupported browsers fail closed.
There is no generic upstream proxy or unknown-path document fallback.

Preview documents are not cached. The response inserts the r3 runtime before
publisher scripts without changing original or retained Markdown bytes. An
injected import map preserves `/r3/utility.js` as a context-scoped import. Native
resources retain private caching, validators, and ranges, varying by User-Agent
and fetch destination. Resource CORS permits opaque module/fetch/XHR/font reads,
including error responses, without permitting credentials. It does not apply to
application APIs or gate HTML.

The parent accepts a bridge connection only from its exact iframe window,
`Origin:null`, context id, and a published path, after gate readiness. Each document
transfers a MessagePort to the exact application origin. Replies stay on that
port, so navigation cannot deliver a pending result to a replacement document.
The bridge exposes context, same-artifact conversations, human feedback/replies,
explicit Submit, and change notifications. It has no generic HTTP or host-command
operation and accepts no actor or version override. Mutations require browser
user activation. Published membership is checked before dispatch; reply ids must
belong to the same artifact, and the server validates each native target.
Application authentication stays in the parent.

Real-browser checks cover native resources, opaque storage and parent isolation,
denied workers/devices, scoped navigation, blocked external connections, and
WebRTC with a controlled UDP sink. The integrated workspace checks utility
messages, shared threads, version switching, original Locate, and HTML/Markdown
navigation. See `docs/artifacts/verification.md` for commands and browser evidence.

## Publication and persisted data

Publication paths are canonical relative paths, validated independently of the
publisher's operating system. Reject traversal, ambiguous separators, duplicate
membership, unsafe metadata, and invalid base64. Count decoded bytes as well as
transport bytes. Source and rendered targets validate version membership and native
coordinates; arbitrary HTML selectors never become filesystem paths or code.

Publisher directory capture rejects symlinks/special files, checks real paths,
opens with O_NOFOLLOW, compares file identity and metadata around bounded reads,
and scans membership again. Git capture uses inert argv, validates references,
disables external diff/textconv/fsmonitor commands, bounds output/runtime, reads
immutable object IDs, and detects index or working-tree changes. No shell receives
untrusted text. Capturing a directory includes hidden files; examples should use a
prepared publication directory, not an unrelated checkout or home directory.

Blob storage is private, immutable, content-addressed, fsynced, and hash-verified.
Publication prepares bytes before the atomic metadata transaction. Garbage
collection coordinates with active publication leases. Database and content paths
are runtime configuration, never hardcoded machine paths. Migration obtains the
daemon lock, writes a new private consistent backup, imports under an exclusive
transaction, verifies integrity, and retains missing/uncertain historical evidence.
Do not use the real user store for development checks.

## Publisher-side wake adapters

`cli/artifact-listener.ts` discovers and runs local adapters. The current adapter
implementations in `server/listener.ts` and `server/inbox.ts` are only imported by
the CLI. Socket paths, Claude messaging tokens, and Codex executable discovery
stay on that publisher. The remote daemon only gets a logical actor and outward
connection. A generic failure acknowledgment never includes harness diagnostics.

Claude delivery validates a same-owner session socket and requires its authenticated
messaging token. An unattributed write may be held without a receipt, so absence
is a capability failure, not a successful registration. Codex capability and queue
calls share the same bounded local runner with inert argv. The background listener
inherits credentials through its environment, never argv or temporary files, and
reports readiness over IPC only after registration. A successful write/queue exit
acknowledges transport delivery; it does not mark feedback read.

## Limits of the trust model

Other local processes can reach local no-login boot. Protecting against another
local UID would require a different transport/bootstrap boundary. Logical agent IDs
are attribution inside the owner's trusted API, not separate authorization principals.
A scoped preview context grants one version's bytes only; it confers no application
credential or authority over other artifacts.

## Dependency cooldown (supply chain)

A new package version is adopted only after a **3-week** minimum age, on both
update paths:

- `bun`'s `minimumReleaseAge` (`bunfig.toml`, in **seconds** — 1814400) gates every
  local `bun install`/`add`/`update`;
- a matching Dependabot `cooldown` (`default-days: 21`, `.github/dependabot.yml`)
  gates bot PRs.

So a freshly-published compromised release can't be pulled in before it's had time
to be caught. Cooldown covers **version updates only** — Dependabot *security*
updates bypass it so a real fix isn't held back. **Never disable or lower the
cooldown to land a dependency**; if a needed version is younger than 21 days, stop
and say so.
