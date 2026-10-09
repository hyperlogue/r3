---
name: security-model
description: r3's Host/origin/auth guards, isolated artifact preview and closed network policy, local and remote server configuration, publisher-side harness credentials, byte/path guards, migration storage, and dependency cooldown. Use when changing authentication, artifact or preview routes, resource serving, exposure settings, remote transport, or reviewing security impact.
---

# r3's security model

This file owns the security design. The server defends against browser-borne
attacks and casual remote access; executable artifacts default to a verified
closed network boundary. Unsupported browsers can use restrictive compatibility
mode after risk acknowledgment. Only HTML artifacts can explicitly opt into broader external
connections while retaining the opaque sandbox. The product has one trusted human owner and multiple
logical agents, not multi-user accounts or per-agent permissions.

## Application boundary

`server/artifact-server.ts` binds the application listener on loopback and serves
scoped preview paths through it. All-interface binds are rejected.
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

Login tokens expire after `authTokenIdleDays` of inactivity (14 days by
default; a positive integer). `R3_AUTH_TOKEN_IDLE_DAYS` overrides persisted config.
Successful login persists `last_used_at` immediately. Cookie authentication keeps
the latest use per token in memory; the once-per-minute sweep saves pending uses
in one transaction. Graceful storage close flushes pending uses too; an unexpected
termination can lose up to one minute of activity.
Authentication and token listings use pending timestamps, and each cookie request
still checks persisted session expiry and token revocation. Regular browsing reads
authentication state without writing SQLite. Never-used tokens age from
`created_at`. A token is valid only while its effective last-use time plus the
configured window is later than the current time. Check before recording use,
so overdue credentials cannot refresh themselves. Inactivity checks and listings
do not write an expiry marker; `revoked_at` records manual revocation only.
Automatic cleanup retains token/session rows during the run. Storage startup
deletes inactive or manually revoked tokens, their sessions, and expired sessions.
Manual revocation retains its transactional session deletion, including inactive
tokens when revoking all.
The separate master API token is outside this login-token policy.

`REQUIRE_LOGIN` defaults on when publicUrl, allowedHosts, or bind config indicates
non-loopback access. A setting is policy, not proof of the network topology. On a
local no-login instance, boot supplies the master token to the same-origin browser.
With login required, boot exposes no master token: a revocable login token creates
an HttpOnly, SameSite=Strict cookie, Secure at an HTTPS edge. The proxy must set
X-Forwarded-Proto correctly. Individual revocation of the caller's current login
token is refused; revoke-all is the deliberate escape hatch.

Application HTML can embed bootstrap and the addressed artifact's detail after
the same Host/origin checks and browser-session validation as bootstrap. Local
no-login mode retains its existing bootstrap trust boundary. The embedded detail
uses the API's complete shape and collaboration state; it seeds the browser query
cache, while SSE ready/reconnect still reconciles current state in the background.
The same authenticated snapshot may include the selected HTML version’s bounded
file manifest. For an HTML GET, it may also renew existing restrictive contexts
for the selected version’s declared entrypoint using bounded resume hints, or
prepare a blocked/compatible pair when no live hint matches. The browser selects
from its local consent state only after bootstrap and cache-suspension checks,
verifies the application origin and artifact/version/path, and consumes setup once.
A retained descriptor must match this tab’s exact sessionStorage context ID.
Another tab’s hint cannot make the client adopt that tab’s revocation lifetime.
It still requires manifest membership and gate success or remembered consent.
The first valid preview request retires the unused mode; no cleanup HTTP request
is needed. External access is never prepared. HEAD and invalid explicit versions
prepare nothing. Capacity/configuration failures omit setup and leave the ordinary
API fallback available. Agent labels carry no credentials.
Application documents are `private, no-store`, have no reusable validator, and
escape `<` in embedded JSON. Static bundles retain immutable caching. Remote
snapshots contain no API token. Cross-site/opaque requests and missing or revoked
sessions receive only the generic shell, followed by same-origin `/api/boot`.
This preserves Strict-cookie entry without widening cookie policy or API access.

An HTML snapshot must never resume suspended Markdown/image caches: its request
predates the browser's cache-generation read. If either cache is suspended or its
logout state cannot be read, discard the snapshot and authenticate through
`/api/boot` with the existing epoch guards. Storage failure loses only the inline
authentication optimization; a current successful bootstrap still opens the app.
Otherwise inline bootstrap leaves cache suspension state untouched. A document
restored from the back/forward cache reloads rather than reusing its auth snapshot.

A proxy that rewrites Host to loopback can conceal remote exposure. Set
`requireLogin` explicitly for such a deployment and advertise the application's
publicUrl. Never rely on the proxy being detectable. Remote clients resolve environment, project, and user backend selection, then use
saved access from `r3 login`. A different origin/path never inherits credentials.
Both clients and probes reject redirects when carrying credentials.

Settings resolve environment → `$XDG_CONFIG_HOME/r3/config.json` → defaults.
Configuration contains no secret. Supported settings include application bind,
port, publicUrl, allowedHosts, requireLogin and authTokenIdleDays.
Changes take effect at restart. The authenticated
preview-creation request chooses the browser's application origin and the existing
listener dispatches `/__r3_preview/` through the preview module after the Host
guard. No second port, wildcard DNS, or Tailscale Serve change is needed.

For an application proxy that rewrites Host, the preview dispatcher can normalize
only a context whose transport origin equals its application origin and appears
in the configured application-origin set. The application Host guard runs first;
arbitrary forwarded headers never authorize that normalization.

## Preview host

`server/preview-host.ts` serves one immutable version per temporary random path
under `/__r3_preview/<context>/`. Exact host/port and context membership are checked
before every response. Contexts expire after one hour without application renewal;
revocation or artifact deletion invalidates the whole context. These unguessable
URLs grant one version's resources, never application or other-artifact authority.
They are scoped bearer capabilities and must not be placed in logs or referrers.

Mounted previews renew periodically and when the tab becomes visible, with one
renewal in flight per preview. A renewal 404 after expiry or server restart starts
fresh authenticated setup for the selected version and current document. Recovery
stops capture, clears device consent, and repeats the gate or checks remembered
compatibility consent before admitting the replacement. Other renewal failures
remain visible for explicit retry; context creation failures stop recovery.

Each document has `sandbox allow-scripts` in both the iframe and response CSP.
The browser assigns a fresh opaque origin on every navigation, even when two
previews share a transport hostname. The iframe is also credentialless, avoiding
ambient application cookies in transport requests. Persistent storage, workers,
nested frames, and direct native camera/microphone capture are unavailable. Neither publisher scripts
nor a device grant can restore a real origin. Top-level published-document
navigation is refused; rendering belongs inside the workspace. Browsers without
credentialless iframe support still enforce the opaque sandbox and application
origin guards; do not claim they omit transport cookies.

In the default blocked mode, before the workspace requests published bytes, a
trusted gate verifies its opaque origin, an allowed fetch, blocking of a working endpoint outside the allowlist,
and WebRTC rejection with no ICE servers and relay-only transport. Both fetch
probe endpoints permit credential-free CORS, so a CORS failure cannot stand in
for network enforcement. The gate reports its result directly to the trusted
workspace, which controls publisher execution. There is no server challenge,
verification POST, or User-Agent registration. The temporary context capability
authorizes bytes independently of the gate; `Origin:null` is not an authentication
principal. No cookie authorizes preview resources. Gate HTML has no CORS headers.
Direct document navigation remains refused and `frame-ancestors` permits only the
application origin. The workspace admits interactive publisher content after
successful browser checks or remembered compatibility consent. Hiding an executing
document is not admission control.
For an HTML version's declared entrypoint, context setup and the gate can run
alongside the file manifest; the document waits for manifest membership and either
gate success or remembered compatibility consent before loading.
The allowed-fetch, forbidden-fetch, and WebRTC probes run concurrently. The gate
still requires every applicable result; allowed-fetch failure is a transport
error, never proof of network blocking or a reason to offer compatibility consent.
Previously opened Markdown has a separate passive reading projection after normal
application authentication. A template-based allowlist removes resource/navigation
attributes, scripts, forms, embedded documents, and active SVG. It is displayed only
in an opaque iframe with a restrictive meta CSP placed before cached markup. The
only script allowed by its fresh nonce is r3's layout/scroll helper, whose exact
window/nonce channel carries no preview/API/cache authority. The interactive
preview retains the real server response policy and all existing gate/consent checks.

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
renewal only extends expiry. Switching policy revokes the preceding context; an
external context is always revoked when released. No artifact metadata, publication, or publisher script can
change the browser's choice. The trusted workspace asks for confirmation before
external access, keeps an indicator visible, and resets that grant on version change
or leaving the preview. It does not persist external-resource or device grants. Reload/tab close starts the
next visit protected, but does not guarantee React cleanup or server revocation;
an abandoned URL capability can remain valid until expiry.

The workspace retains up to 16 inactive protected document context identities in
tab-scoped sessionStorage, excluding external contexts, device grants, and document
bytes. Mounted contexts are not evicted. In-app reopening authenticates renewal
and repeats the gate unless compatibility consent is remembered; only a missing
or expired context permits recreation. Full HTML navigations renew those same
identities without a separate request when the optional application hint cookie
names a matching live scope. The cookie contains at most 16 truncated SHA-256
lookup keys, not URL capabilities, credentials or consent. It is a session cookie
with Path=/, SameSite=Strict and Secure on HTTPS, and logout clears it. Only the
authenticated application bootstrap resolves hints; matching requires the exact
artifact, version, entrypoint, application origin and restrictive document policy.
The resource dispatcher never accepts hints as authorization. Missing, evicted or
unusable hints fall back to authenticated API renewal of the tab’s saved ID,
preserving URLs. A new independent tab rejects other tabs’ retained descriptors
and creates its own context through the API. Abandoned contexts retain the
one-hour expiry and shared 512-context cap. Fresh preparation rolls back a partial
pair at capacity; existing contexts remain renewable. Deletion removes saved handles and revokes
their contexts; an unavailable artifact also clears its handles when revisited.
Inactive retained capabilities expire normally. Media contexts are released normally.

Compatibility mode retains all blocked-mode response headers, including CSP and
Connection Allowlist where implemented, but skips proof of network enforcement.
Remembered consent loads the document directly, without a gate document, allowed
or forbidden fetch, or WebRTC probe. The parent requires a secure context and
authenticated scoped context setup; server transport, membership, sandbox and
origin guards remain enforced. The actual document bridge must originate from
the exact iframe with an opaque origin before becoming interactive. It is available
for HTML and rendered files, never diffs. Camera/microphone relay remains disabled.
This mode cannot promise to prevent exfiltration: navigation, WebRTC, and other
browser-dependent gaps can transmit data even though ordinary external resource
loads and fetches remain restricted. Do not label it a closed network.

Without remembered consent, the trusted workspace first attempts `blocked`. Only
the trusted gate's network-specific failure can offer compatibility consent; gate
messages after admission are ignored so publisher scripts cannot forge a downgrade.
Before consent no published bytes are requested. Declining leaves the preview
closed with an action to reopen the warning. Acceptance is remembered under a
versioned localStorage key for this application origin/browser; unavailable
storage falls back to memory for the application load. Accepted previews select
`compatible` immediately on reloads, new tabs, and version changes. There is no
expiry, browser-version invalidation, or background capability recheck, including
after browser upgrades. Clearing site storage or **Forget browser choice** restores
blocked-mode checks; the indicator remains amber even on capable browsers.
One application-level warning owner prevents simultaneous file/media previews
from stacking dialogs. A decline suppresses further automatic prompts for that
application load; each closed preview retains its explicit review-risk action.
Forgetting the choice revokes active compatible contexts in this tab and other
open tabs and starts blocked-mode verification.
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
opaque origin and reachability, but skips network-blocking
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

Preview documents use private HTTP caching with mandatory revalidation. Their
validators cover retained bytes, context, trusted runtime, and response policy;
context membership, expiry, and navigation guards precede every conditional response.
A matching validator skips blob reads and HTML rewriting, never authorization.
Runtime and utility scripts also revalidate privately, with validators covering
their bytes and response policy after the same context and revocation checks.
Gate responses remain uncached. The response embeds the r3 runtime inline before
publisher scripts, escaping HTML script delimiters without changing original stored
bytes. Document validators include this runtime and its injection revision, so a
cached response cannot retain a replaced runtime. Generated documents and support
scripts negotiate gzip and vary on Accept-Encoding; native resource ranges retain
their exact-byte contract. Retained Markdown instead
loads an empty, policy-bearing shell at its native URL. The trusted parent owns a
64 MiB / 30-day IndexedDB cache of retained Markdown, checks its hash against the
authorized file manifest, and delivers only the current document over its exact
verified port. A miss reads `/r3/markdown?path=` inside the existing expiring
capability; this attachment-only text endpoint is not a permanent content URL.
No context URL, injected script, or grant is saved with cached document bytes.
Logout/unauthenticated boot, deletion, and definitive access failures purge
entries. Logout/authentication failure also suspends persistent cache access across
tabs until normal authenticated bootstrap. Its captured generation prevents a boot
response begun before logout from resuming writes afterward. Context-renewal 404s
do not establish artifact deletion and retain cached bytes.
An IndexedDB generation guards against late writes across tabs; reconnect
reconciles cached artifacts with the server. Browser-profile storage remains a
local copy, not encrypted or remotely erasable while offline.
An injected import map preserves `/r3/utility.js` as a context-scoped import in authored HTML. Native
resources retain private caching, validators, and ranges, varying by fetch
destination. Resource CORS permits opaque module/fetch/XHR/font reads,
including error responses, without permitting credentials. It does not apply to
application APIs or gate HTML.

The parent accepts a bridge connection only from its exact iframe window,
`Origin:null`, context id, and a published path, after gate readiness or remembered
compatibility consent. Each document transfers a MessagePort to the exact application origin. Replies stay on that
port, so navigation cannot deliver a pending result to a replacement document.
The bridge exposes context, same-artifact conversations, human feedback/replies,
explicit Submit, change notifications, and an artifact-scoped light/dark preference. It has no generic HTTP or host-command
operation and accepts no actor or version override. Mutations require browser
user activation. Published membership is checked before dispatch; reply ids must
belong to the same artifact, and the server validates each native target.
Selection, element picks, comment-mode toggles, and composer focus messages are
UI actions on the current verified port, accepted only while that exact iframe
has focus and no modal owns the keyboard. They can prepare a native draft, never
submit it. They do not depend on
transient activation: a long mouse drag and idle Escape remain valid. Conversation
mutations and utility writes retain their activation checks.
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

Repository remotes are grouping hints, not authorization or fetch instructions.
`shared/git-remote.ts` removes URL user information, query strings, and fragments;
local paths, file URLs, and helper syntax are rejected. The server independently
normalizes hints and never executes Git or accesses the remote. Explicit project
selection wins over server aliases and automatic remote mappings. The primary
remote update supports compare-and-set backfill through the authenticated API;
no publisher writes SQLite. Existing artifact assignments remain stable.

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
server lock, writes a new private consistent backup, upgrades artifact schemas
under an exclusive transaction, and verifies integrity. Already-imported history
remains readable; live-review stores require an intermediate upgrade with r3 1.5.0.
Do not use the real user store for development checks.

## Client authorization and local wake delivery

Read the [remote protocol](../../../docs/artifacts/remote-protocol.md) when changing
backend selection, API keys, device login, token rotation, audit, or worker routing.
It owns the language-neutral routes, limits, lifetimes, and recovery rules. Browser
approval requires an authenticated browser and an explicit decision. API keys cannot
approve devices on an exposed server. Public OAuth routes retain Host/Origin guards,
bounded form parsing, polling cadence, expiry, and rate limits. Preview isolation is
unchanged. Tokens and device secrets are hashed in backend storage.

The worker opens only a private Unix socket and outgoing authenticated streams.
Its separate IPC credential, owned 0700 directory, 0600 files/socket, and rejection
of every Origin header keep harness details off application HTTP. Local paths,
executables, Codex home and Claude messaging credentials remain in the private
worker file; they never enter a backend registration. Private saved backend
credentials are keyed by the complete normalized URL, atomically replaced, and
refreshed under a process lock. A rejected backend pauses independently until login.

Backend routing contains opaque worker/listener/registration IDs and attribution.
A connection and retained subscription are bound to their authorizing credential
principal. Expiry/revocation closes transport and leaves a visible unavailable
subscription. Reconnect requires the same worker and principal; a different grant
cannot attach by guessing the worker ID. Replacement, unlisten, archive, and deletion
end subscriptions permanently. An old connection or acknowledgment cannot displace a
new selection. A notification acknowledgment cannot consume conversation content.
Existing private migration backups may retain legacy local targets.

Claude delivery validates a same-owner session socket and uses its authenticated
messaging token. Codex uses bounded direct argv with the captured local executable
and optional Codex home, without a shell. Raw harness errors never enter backend
responses or logs. Queue acceptance is not proof of a running consumer.

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
- the pinned npm's `min-release-age` (`toolchain/.npmrc`, in **days** — 21)
  gates manual toolchain resolution; installs disable lifecycle scripts;
- a matching Dependabot `cooldown` (`default-days: 21`, `.github/dependabot.yml`)
  gates bot PRs.

So a freshly-published compromised release can't be pulled in before it's had time
to be caught. Cooldown covers **version updates only** — Dependabot *security*
updates bypass it so a real fix isn't held back. **Never disable or lower the
cooldown to land a dependency**; if a needed version is younger than 21 days, stop
and say so.


## Feedback image isolation

Image reads use application authentication and artifact/message membership, never
a blob hash capability or the preview resource allowlist. Raster responses deny
sniffing, cross-origin embedding, executable navigation, and persistent HTTP
caching. PNG validation checks chunks, checksums, dimensions, bounded decompression,
and scanline filters; JPEG validation checks marker structure and dimensions.
Only static PNG/JPEG are stored. Ancillary identifying metadata is removed; the
browser normalizes image uploads before sending. These are bounded format checks,
not a replacement for the browser's raster decoder.

Published HTML receives neither attachment descriptors nor bytes from `getThreads`.
It cannot request screen capture through the utility. Preview response and iframe
permissions explicitly deny display capture. Parent-owned Capture area needs a
fresh browser chooser; Region Capture must succeed for the current preview before
any frame is read. `ImageCapture.grabFrame()` reads a single cropped frame; no
uncropped pixels enter a canvas. Streams remain in the trusted parent, with audio disabled, and
stop after one frame or cancellation. Late permission results are stopped. This
path does not use RTC, external-network consent, or the existing device relay.

Draft image bytes stay in IndexedDB with bounded per-image size. Authenticated boot
resumes access; logout suspends/clears it across tabs. Stored generations reject
writes and bootstrap completions started before revocation. Deletion also clears
that artifact's draft images. Browser-profile storage is a local copy, not encrypted
or remotely erasable while offline.

### Native media targets

Targetable raster images and videos in files artifacts use authenticated resource
fetches and revocable local blob URLs in trusted img/video elements. No document
execution is admitted through this path; authored HTML and SVG retain opaque
preview isolation. Animation is checked before offering/accepting still-image
targets. Canvas capture stores one full static PNG/JPEG as message-owned immutable
target evidence. Ordinary image edits cannot alter or reuse that ownership.
The existing authenticated attachment route, raster validation, GC coordination,
logout revocation and no-store response policy apply. Media snapshot plus four
ordinary attachments are bounded by a 40 MiB message request. Snapshot provenance
is client-supplied evidence, not a server claim of video decoder equivalence.
