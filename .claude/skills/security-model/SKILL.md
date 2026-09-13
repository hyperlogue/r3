---
name: security-model
description: r3's Host/origin/auth guards, isolated artifact preview and closed network policy, local and remote daemon configuration, publisher-side harness credentials, byte/path guards, migration storage, and dependency cooldown. Use when changing authentication, artifact or preview routes, resource serving, exposure settings, remote transport, or reviewing security impact.
---

# r3's security model

This file owns the security design. The daemon defends against browser-borne
attacks and casual remote access; executable artifacts default to a verified
closed network boundary. Unsupported browsers can use restrictive compatibility
mode after risk acknowledgment. Only HTML artifacts can explicitly opt into broader external
connections while retaining the opaque sandbox. The product has one trusted human owner and multiple
logical agents, not multi-user accounts or per-agent permissions.

## Application boundary

`server/artifact-server.ts` binds the application listener on loopback; an explicit
preview endpoint adds a separate loopback listener. All-interface binds are rejected.
The application Host guard runs before API, preview dispatch, and static assets.
Allowed application hosts are exact local, explicitly allowlisted, or advertised
public hostnames; never wildcards. Transport hostnames are not document identities:
opaque preview documents
serialize their Origin as `null`, which the application guard rejects.

`server/artifact-auth.ts` gates every API request by full origin, including port.
A configured application origin supports a proxy that rewrites Host. Opaque
preview origins must never enter that set. No-Origin CLI requests are allowed, but browser
cross-origin Fetch Metadata does not acquire that exemption. No cross-origin
access headers are emitted.

Every application data route, including event streams, requires the master API token or a
valid browser cookie. Browser and agent streams use authenticated fetch, with no
token-free SSE exception. GET/HEAD health and same-origin boot, and POST login,
retain narrow bootstrap roles. Token comparisons are constant-time; reads carry
private cache policies. JSON bodies are bounded while streaming after auth.

Application resource downloads are attachments with restrictive CSP, `nosniff`,
no-referrer, and same-origin resource policy. Shell and assets are explicitly
served by `application-assets.ts`, with frame-ancestors none and X-Frame-Options
DENY. Missing asset paths return 404; only known artifact page routes get the shell.
Executable published HTML always runs with an opaque browser origin, even when
its transport URL uses the application address.

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
Changes take effect at restart. With no preview override, the authenticated
preview-creation request chooses the browser's application origin and the existing
listener dispatches `/__r3_preview/` through the preview module after the Host
guard. No second port, wildcard DNS, or Tailscale Serve change is needed.

An explicit `previewBaseUrl` selects one HTTPS endpoint (or HTTP loopback locally).
Only then is `previewPort` used, defaulting to application port + 1 and requiring
a distinct valid port. The extra listener has no application routes or credentials.
Forward its Host and paths unchanged. Clear the override to use automatic hosting.

For an application proxy that rewrites Host, the preview dispatcher can normalize
only a context whose transport origin equals its application origin and appears
in the configured application-origin set. The application Host guard runs first;
arbitrary forwarded headers never authorize that normalization. The dedicated
preview listener accepts no such proxy-origin exemption.

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
nested frames, and direct native camera/microphone capture are unavailable. Neither publisher scripts
nor a device grant can restore a real origin. Top-level published-document
navigation is refused; rendering belongs inside the workspace. Browsers without
credentialless iframe support still enforce the opaque sandbox and application
origin guards; do not claim they omit transport cookies.

In the default blocked mode, before published bytes become available, a trusted gate verifies its opaque
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
CSP disallows ordinary and blob workers too. Unsupported browsers fail closed in
the default network mode. The gate distinguishes a network-policy limitation
from isolation, transport, and verification failures; only the first permits a
consented compatibility fallback.
There is no generic upstream proxy or unknown-path document fallback.

Authenticated preview creation accepts `network: "blocked" | "compatible" | "external"`, defaulting
to `blocked`. The server rejects `external` for every kind except `html`, including
HTML documents inside a `files` artifact. Policy is immutable within a context;
renewal only extends expiry. Switching policy requires a new context and revocation
of the preceding one. No artifact metadata, publication, or publisher script can
change the browser's choice. The trusted workspace asks for confirmation before
external access, keeps an indicator visible, and resets that grant on version change
or leaving the preview. It does not persist external-resource or device grants. Reload/tab close starts the
next visit protected, but does not guarantee React cleanup or server revocation;
an abandoned URL capability can remain valid until expiry.

Compatibility mode retains all blocked-mode response headers, including CSP and
Connection Allowlist where implemented, but skips proof of network enforcement.
It still requires secure transport, an opaque origin, resource reachability, and
the browser-bound single-use challenge before publication access. It is available
for HTML and rendered files, never diffs. Camera/microphone relay remains disabled.
This mode cannot promise to prevent exfiltration: navigation, WebRTC, and other
browser-dependent gaps can transmit data even though ordinary external resource
loads and fetches remain restricted. Do not label it a closed network.

The trusted workspace first attempts `blocked` for every preview visit. Only the
trusted gate's network-specific failure can offer compatibility consent; gate
messages after readiness are ignored so publisher scripts cannot forge a downgrade.
Before consent no published bytes are requested. Declining leaves the preview
closed with an action to reopen the warning. Acceptance is remembered under a
versioned localStorage key for this application origin/browser; unavailable
storage falls back to memory for the application load. It applies to future
network-policy failures only, so browser upgrades still gain verified protection.
One application-level warning owner prevents simultaneous file/media previews
from stacking dialogs. A decline suppresses further automatic prompts for that
application load; each closed preview retains its explicit review-risk action.
Forgetting the choice stops compatible previews in this tab and other open tabs.
It does not undo data already transmitted or cancel independently granted external mode.

A shield row in the trusted top navigation’s three-dot menu summarizes all mounted previews.
Green requires successful blocked-mode gates for every preview. Amber means limited
protection, explicit external access, or device permission; red signals active
sharing or an error. Checking and failed previews never show verified protection.
An accessible label and visible text name the state. Expanding the row lists each preview's
isolation, network, camera, and microphone details and retains permission, restore,
stop-sharing, and forget-compatibility controls. Confirmation remains explicit and
HTML-only for external access. These indicators describe enforced boundaries, not
the trustworthiness of publisher content.

External mode omits Connection Allowlist and WebRTC blocking and permits HTTP(S)
resources and HTTP(S)/WS(S) connections in CSP. Browser CORS and mixed-content rules
still apply; r3 never proxies requests. Its trusted gate still checks secure context,
opaque origin, reachability, and the single-use proof, but skips network-blocking
probes. This supports browsers lacking Connection Allowlist only after explicit
consent. Both iframe and CSP sandbox, application auth/origin checks, document-bound
bridge, resource membership, and direct native camera/microphone denial remain mandatory.
The r3-served document still denies workers and nested frames through CSP. External
self-navigation is permitted in this mode and may escape compatibility restrictions
in unsupported browsers; its replacement keeps the iframe's
opaque sandbox, denied forms/popups/top navigation, and device policy, but does
not inherit the preceding response's worker/frame CSP. An external replacement
can start blob workers and nested sandboxed frames. Do not describe those CSP
restrictions as persistent across external navigation. The same parent/storage
isolation and application API guards protect r3 throughout. Device consent is
not a network exception.

This exception permits exfiltration of the selected publication's files, user input,
all conversations the same-artifact utility exposes, including other versions'
threads, and explicitly shared camera/microphone data. External dependencies execute with that same access. Explain this before
enabling it; re-enabling protection cannot undo data already sent. The sandbox
continues to deny access to the parent, its credentials/storage, and unrelated
artifacts. No UI may describe this as disabling all security or safe networking.

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
explicit Submit, change notifications, and an artifact-scoped light/dark preference. It has no generic HTTP or host-command
operation and accepts no actor or version override. Mutations require browser
user activation. Published membership is checked before dispatch; reply ids must
belong to the same artifact, and the server validates each native target.
Application authentication stays in the parent. Theme preference reads return only
`light`, `dark`, or null. Writes require activation and accept only those two themes;
the parent chooses the storage key from the verified artifact identity. Previews
cannot enumerate storage, supply keys or other artifact IDs, or alter r3's app theme.
Theme persistence never persists network or device grants.

`web/src/preview-capture.ts` owns the optional device relay. It requires an explicit
camera/microphone grant for the currently bound document connection. The trusted
parent owns physical tracks and permits one native permission request and one
capture at a time; a pending browser prompt remains guarded even after timeout or
revocation. Every asynchronous continuation checks that its capture is still
current, and a late stream is stopped without delivery. Closing or replacing the
connection stops physical tracks directly. Device consent is independent of a
remembered browser permission for r3's origin. The HTML confirmation offers separate,
unchecked camera/microphone choices. They require external network mode and never
persist. Replacing the document also discards an open confirmation dialog. Stop
sharing clears device consent; a spontaneous physical track `ended` event also
revokes consent, so browser/OS termination cannot silently restart capture. A
logical cancellation cannot dismiss a browser-owned permission prompt; any late
successful result is stopped before delivery.

The early runtime registers a capture-phase `pagehide` disconnect before publisher
code. After iframe loads, and every two seconds while requesting/sharing, the parent
sends a fresh nonce to the current iframe window. It must return on the currently
bound port within one second. Timeout revokes capture and consent; new bindings
discard stale probes. This also handles a replaced or unresponsive document whose
load never finishes. The nonce carries no authority or data. Do not replace this
with counts of load events: redirects may skip a gate or document's load event.

The relay sends only requested audio/video. It creates the RTC offer in the parent,
accepts one bounded receive-only answer, and exposes no ICE configuration,
renegotiation, data channel, enumeration, device identifiers, screen capture, or
PTZ. `iceServers: []` avoids configured discovery servers; a peer's answer can
still select a network destination, so this transport requires external-network
consent and must never be described as an in-memory-only relay. Direct iframe
device access remains denied. Returned tracks are RTC receiver tracks; supported
capture constraints and stop/clone behavior belong to the narrow preview utility,
not to a claim of full native device API compatibility.

Real-browser checks cover native resources, opaque storage and parent isolation,
denied workers/direct device access, explicit capture consent, scoped navigation, blocked external connections, and
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
