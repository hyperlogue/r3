---
name: api-surface
description: r3's full HTTP/JSON route catalog and CLI command reference — every /api endpoint with its shape and gating, the r3 CLI usage block, the watch/submit review loop with its exit codes, and the delivery-tracking (sent_at / status_unsent) rules. Use when adding, renaming, or changing an HTTP route or CLI command/flag, wiring the CLI or web client to the server, checking what an endpoint returns, or keeping shared/artifacts.ts + server + CLI + web in sync.
---

# r3's API + CLI surface

This file is the **design source of truth** for r3's route catalog and CLI usage —
update it here when the surface changes. The wire *shapes* live in
`shared/artifacts.ts` (re-exported by `shared/types.ts`); this is the map over them.

**The HTTP/JSON API is the product**, not a detail of the React client — there are
three clients (browser, CLI, agent). When you change behavior, change
`shared/artifacts.ts` and keep server + CLI + web in sync.

## HTTP API

### Artifact API

`server/artifact-api.ts` assembles the API against injected artifact storage.
`server/artifact-daemon.ts` opens and migrates storage before accepting requests.
The CLI, browser, and demo all use this protocol; legacy routes are removed.

- `GET/POST /api/sessions` lists/registers explicit agent identities; labels are
  mutable display names and never identity or delivery addresses;
  `GET/POST /api/projects` and `PATCH/DELETE /api/projects/:id` manage optional grouping.
  PATCH accepts `EditArtifactProjectBody` (name, remoteUrl, optional expectedRemoteUrl).
  Remote backfill can require the current field to be null; concurrent changes conflict.
  Removing a group preserves its artifacts and deletes its automatic remote mapping.
- `GET/POST /api/artifacts`, `GET/PATCH/DELETE /api/artifacts/:id` list, create,
  inspect, edit metadata, or delete the whole artifact. Creation accepts a sanitized
  `remoteUrl` hint for server-configured project inference; explicit `projectId`,
  including null, wins. List filters are `state`,
  `kind`, `project`, and `meta.<key>`. No repo header or local path is involved.
  Artifact detail includes `agentLabels`, current display labels keyed by the
  sessions referenced in its creator, versions, feedback, replies, claims, and
  lifecycle events. Unnamed entries are null; unrelated sessions are omitted.
  The browser uses these labels without fetching the global session list.
  Artifact reads include computed `unhandledCount`: open threads whose latest
  message is from an agent. Reading, delivery, and claims do not clear it.
  `storage.totalBytes` and `storage.latestVersionBytes` report deduplicated published
  content and the latest publication's full footprint, excluding database/filesystem
  overhead. See [storage accounting](../../../docs/artifacts/schema.md#content-storage-accounting).
  `latestVersion` is null before publication, otherwise a list projection of the
  latest committed sequence, label, summary, and publication time; never `nextSeq - 1`.
  Artifact metadata has no overview/summary field. Publication summaries remain
  immutable version metadata; `edit --summary` is unsupported.
- `GET /api/search?q=...` returns `ArtifactSearchResponse` from `shared/artifact-search.ts`
  (re-exported by `shared/artifacts.ts`). Filters: `state=active|archived`,
  `kind=files|html|diff`, `project=<id>`, `attention=true|false`, `history=latest|all`,
  `type=all|content|conversation`, `limit=1..100` (default 50), and `offset=0..100000`.
  Queries contain 1–16 Unicode word prefixes, at most 256 characters, combined with AND;
  punctuation is a separator and FTS syntax is never executed. Latest scope limits
  publications; conversation matches retain each message’s recorded context. Results
  contain plain-text snippets, native targets, feedback/reply IDs, per-type counts,
  and `nextOffset`. `skippedFiles` reports excluded binary, invalid UTF-8, or >4 MiB
  text files in the selected scope. HTML searches static entrypoint text without
  executing scripts or searching companion source. Same authentication/origin guards
  as artifact reads; no feedback acknowledgment, claim, listener, or delivery effect.
  CLI: `r3 search "words"` with corresponding flags, `--attention`, and `--json`.
- `GET/POST /api/artifacts/:id/versions` lists retained versions or publishes a
  complete version with `expectedSeq`, `publicationKey`, explicit `actor`, and
  optional boolean `listen` (default true). A new commit replaces the fallback
  using a locally registered target, or clears it when absent/disabled. Replays
  cannot reclaim the fallback.
  There is no per-version delete. `GET .../versions/:seq` reads version metadata.
- `GET .../versions/:seq/files|source|resource|diff|diff-context|patch` reads
  membership, highlighted source, original bytes, rendered sparse diff, retained
  context, or original patch. `source` and `resource` take `?path=`;
  `diff-context` takes `?path=&start=&end=` in new-side coordinates. Highlighted
  reads accept `?theme=`. Resource GET/HEAD supports ranges and validators;
  app-origin HTML is always an attachment. Missing bytes never fall back to a
  different version or the filesystem. Executable rendering belongs to preview.
- `GET/PUT /api/artifacts/:id/viewed` persists opaque read-progress keys with
  `{ key, viewed }`. Theme and login-token endpoints retain their response shapes.
- `GET/POST /api/artifacts/:id/feedback`, `GET/PATCH/DELETE /api/feedback/:id`,
  `POST /api/feedback/:id/replies`, `PATCH /api/replies/:id`, and
  `PUT /api/feedback/:id/placements` use native immutable original targets,
  explicit reply context, and separate placements. Every message mutation names
  an `actor`; deletion takes `{ actor }`. Only human actors change feedback status.
  Rendered locators accept an optional plain-text `label` for named HTML fix links;
  matching still uses the selector and native evidence. See `r3 guide html` for
  the reply example and the schema document for storage semantics.
  `artifact_summary` and `version_summary` are historical read-only targets;
  new feedback, reply fix targets, and placements reject description anchors.
- `GET /api/feedback/:id/source` returns `ArtifactSourceRange` for the original
  source/diff line target: artifact, version, path, side (`null` for source),
  inclusive start/end, and complete text with LF separators. Rendered, general,
  and whole-file targets return 400; missing feedback returns 404. The normal
  authentication and origin guards apply. This read never acknowledges feedback,
  claims it, or registers a listener. Source/diff quotes may be nonblank exact
  excerpts within the complete captured range; range existence, version/file/side,
  diff gaps, and input limits remain validated. Browser excerpts are capped at
  four lines and 2,048 UTF-16 code units; existing saved quotes are unchanged.
- `POST/DELETE /api/claims { sessionId, feedbackIds }` claims/releases as the
  named registered agent. Claims change presence, not owner delivery.
- `GET .../:id/feedback/pending[?feedback=<ids>]` returns an
  `ArtifactFeedbackSnapshot`: formatted `text`, `itemCount`, and an `acknowledgment`
  containing the selection and required `expectedFingerprint`. It is read-only and
  uncached; archived artifacts return 409.
  `POST .../:id/feedback/acknowledge` takes that `ArtifactFeedbackAcknowledgment`
  after successful consumption and returns `{ acknowledgedCount }`. Missing/invalid
  fingerprints return 400; stale revisions, changed selection, or archive return 409
  without marking content delivered. The fingerprint binds artifact, selection, and
  persisted conversation revision, including edit/revert and prior acknowledgment.
  `GET .../:id/feedback/history[?feedback=<ids>]` returns `ArtifactFeedbackRead`
  (`text`, `itemCount`) without acknowledgment data: open history by default, or the
  specified threads including resolved ones. History remains readable after archive.
  The browser copies only the CLI command and makes no feedback-read or acknowledgment
  request. The former `/prompt` routes and CLI alias are removed.
- `POST .../:id/submit` returns `{ notification }`; `sent` confirms a local harness
  delivery acknowledgment or a generic watch woken for pending feedback. An absent
  recipient (or a watch with no pending work) returns `none`. Local Codex acceptance
  returns `queued`; failure returns `failed` and HTTP 502. Neither drains feedback.
  `POST .../:id/lifecycle` takes `ArtifactLifecycleBody`, returning the persisted
  event, replay flag, and notification result. Delivery failure is HTTP 502;
  the committed archive remains authoritative. Replays do not notify twice.
- `GET .../:id/watchers`, `POST .../:id/watch { actor, timeoutMs? }`, and
  `POST .../:id/listen { actor }` select one explicit recipient ahead of a persisted
  local fallback. New explicit registrations supersede previous ones.
  `DELETE .../:id/listen { actor }` removes that actor’s registrations. Watch is
  bounded long polling; listen is an outward SSE connection from the publisher.
  `POST /api/connections/:id/acknowledgments` acknowledges local harness delivery.
  These HTTP routes receive no harness socket, executable path, or harness credential.
- `GET /api/events[?artifact=<id>]` is an authenticated fetch stream of
  `ArtifactStreamEvent` invalidations. `ready` means refetch current state;
  `heartbeat` keeps the connection alive. Neither implies message delivery.

All data and streams require authentication. JSON reads use private validators
and gzip; body readers count actual streamed bytes after authentication, with a
200 MiB transfer cap for publications and smaller limits for ordinary commands.
Source validators include version membership, theme, and the source renderer
revision, allowing a conditional read to skip blob access and highlighting.

The matching command runner is `cli/artifact-commands.ts`; its complete help and
agent guide are `cli/artifact-help.ts`. The binary dispatches through `cli/artifact-main.ts`. Capture/publication
is isolated in `cli/artifact-publish.ts`: complete bytes are prepared before a
create write, and an unconfirmed upload reports the artifact, expected sequence,
and retry key for recovery. Source/download reads require a version. Native target
flags reject cross-representation guesses. `--session` supplies a readable name;
`R3_AGENT_SESSION` supplies stable identity for generic writers/subagents. Generic
watch assigns its own temporary identity; no shared `agent` identity is invented.

The existing local daemon owns wake delivery and persisted registrations. Its
private Unix socket accepts `POST /api/local/target { actor, target }` and
`POST /api/local/listen { artifactId, actor }`; neither is an application HTTP route.
CLI create/publish first registers supported harness details there. Publication
succeeds with a warning if setup fails. `--no-listen` clears the fallback on a new
publication. Local `listen` returns after persistence; it starts no child process.
The existing remote `listen` relay remains in `cli/artifact-listener.ts` and waits
for IPC readiness. Remote proxying is deferred.

Failed fallback delivery retains its record; failed explicit delivery removes only
that exact registration. No automatic resend goes to another recipient. Registration,
fallback activation, and daemon restart never announce unsent content. Archive
atomically clears durable records; restore requires a new publication/registration.

## Preview and bootstrap routes

- `POST /api/artifacts/:id/versions/:seq/previews { path, network? }` creates a scoped
  preview context. `network` defaults to `blocked`. `compatible` retains restrictive
  headers while skipping proof of network enforcement; the browser chooses it only
  after risk consent. Only `html` artifacts accept `external`. Invalid modes and
  non-HTML external exceptions return 400. The response reports
  the immutable mode. `PATCH /api/previews/:id` renews expiry without changing policy;
  `DELETE` revokes it. Changing policy requires a new context.
  The response contains scoped gate/document/utility URLs and `resourceRoot`,
  plus an optional non-authorizing `resumeKey` for authenticated HTML navigation,
  never application credentials. `origin` is the transport origin; rendered
  documents have opaque origins.
- `GET /api/health` reports version and `protocol: artifacts-v1`; `GET /api/boot`
  supplies local bootstrap or required-login state. Both remain Host/origin gated.
  Authenticated application HTML may inline that bootstrap plus the current
  `ArtifactDetail`, using the same contracts to seed the initial workspace.
  For HTML artifacts it also embeds the selected version’s immutable file manifest
  when at most 128 files and 64 KiB of JSON. Larger manifests use the parallel API
  read. An HTML GET may embed `preview: { applicationOrigin, contexts, retained }`
  for that version’s entrypoint. After authentication, bounded application-cookie
  resume hints renew matching restrictive contexts with stable URLs; without a
  match, setup prepares a blocked/compatible pair. The browser selects using saved
  consent, validates origin and scope, and accepts a retained descriptor only for
  its exact tab-local saved context ID. First use retires an unused prepared
  alternative. Missing hints or mismatched setup use the existing create/renew
  routes, preserving a saved URL when possible. External grants are never embedded.
  Unknown explicit versions never substitute the latest version.
  These documents are private/no-store; cross-site entry, absent session cookies,
  and suspended browser caches fall back to `/api/boot`. API checks remain on
  every data request, and SSE ready still triggers background reconciliation.
- `POST /api/auth/login { token }` mints a browser session; `POST /api/auth/logout`
  destroys it. `GET/POST/DELETE /api/auth/tokens` and `DELETE .../tokens/:id`
  manage revocable login tokens. Current-session individual revocation conflicts.
  Listings omit automatically expired tokens; `lastUsedAt` records successful
  login or cookie authentication. Inactivity policy and startup cleanup belong to
  the [security model](../security-model/SKILL.md#browser-login-and-configuration).
- `GET /api/themes` and `GET /api/theme-style?theme=` return available themes and
  the shared source palette stylesheet.

The preview dispatcher serves its own gate, resources and runtime under
`/__r3_preview/:context/files/` and `/__r3_preview/:context/r3/`. Automatic hosting
uses the Host-guarded application listener; an explicit endpoint adds a separate
loopback preview listener. It serves no application API, proxy, or unknown-path SPA fallback. See
[security-model](../security-model/SKILL.md) for its authorization boundary.
The context capability authorizes resource reads. The trusted browser gate checks
capabilities before the workspace loads publisher content unless browser risk
consent is remembered. Remembered consent selects `compatible` and loads the
document directly until forgotten. There is no server challenge, verification
POST, or User-Agent registration.
`GET/HEAD /__r3_preview/:context/r3/markdown?path=` reads retained Markdown HTML
as attachment-only text after the same context, membership, and navigation guards.
It carries credential-free CORS and `no-store`; the trusted browser owns persistent
Markdown caching. It never serves authored HTML or accepts an artifact/version override.

The browser-only `ArtifactUtility` in `shared/preview-protocol.ts` also exposes
`getUserMedia(constraints): Promise<MediaStream>`. The external-mode runtime adapts
the standard `navigator.mediaDevices.getUserMedia` call to the same device relay.
Only an HTML page with explicit current-document device consent can request it;
browser permission is independent. There is no device HTTP endpoint or grant in
publication/preview metadata. The [security model](../security-model/SKILL.md)
owns the parent capture lifecycle and narrow RTC protocol; the README documents
supported constraints and track compatibility.

## CLI and agent loop

Bare `r3` prints a compact human welcome with quick-start commands and an explicit
pointer to `r3 guide` for agents. It returns without contacting or starting a daemon.
`r3 help`, `r3 --help`, and `r3 -h` print the full command reference.
The welcome, help, and guides come from `cli/artifact-help.ts`; keep them accurate in
any change to commands, flags, results, or protocol. `r3 guide` is the concise
agent workflow, read once per session. `r3 guide html|files|diff` contains only the
preparation details for that kind, loaded when first needed. Unknown topics and
extra arguments fail locally without contacting or starting a daemon. Human
administration and less frequent inspection/metadata commands stay in HELP.
The current command families:

| Commands | Contract |
| --- | --- |
| `create`, `publish` | Local stable capture, complete binary-safe upload; fixed kind, explicit retry key and expected latest publication |
| `list`, `show`, `versions`, `files`, `source`, `download`, `patch` | Read only; content reads name a version; downloads preserve original bytes |
| `edit`, `delete` | Artifact metadata or whole-artifact deletion; no individual version mutation |
| `feedback add/edit/delete`, `reply`, `place` | Native immutable originals, explicit reply context, separate placements; `--human` required for status edits |
| `claim`, `release` | Registered session owns a renewable feedback-scoped lease |
| `feedback fetch`, `watch`, `listen`, `unlisten` | Owner handoff and one designated outward recipient |
| `feedback source <feedback-id> [--json]` | Read the full original source/diff range on demand; numbered text by default, structured range metadata/text with `--json` |
| `archive`, `restore` | Ordered retained lifecycle events, optional archive message, retry operation key |
| `project list/create/edit/delete` | Optional grouping, remote metadata, independent of Git paths |
| `auth`, `config`, `start/stop/status/restart`, `guide` | Browser login management, local configuration and daemon lifecycle |

Creation requires `--kind files|html|diff` before capture or artifact creation.
Publication labels use `--version-label`; `--label` is a compatibility alias, and
supplying both is an error. Authentication-token labels remain `--label`. `--kind html` requires
a root `index.html`; new publications reject Markdown-only directories and
entrypoint overrides. An accompanying `index.md` is ordinary content. Historical
versions retain their entrypoints, including `index.md`. Diff capture flags select
working tree, index, commit, range, or stdin patch. Every version is complete and
independent. `--ref`/`--file` captures a real Git revision on the publisher; there
is no special file-index sentinel. Use `--dir` for current working-tree files,
including any unstaged changes. Diff `--staged` capture still reads the index.

Use a distinct harness identity or `R3_AGENT_SESSION` per logical writing agent.
`--session` only sets its display label; generic watch needs no supplied ID. The client
registers that session before writes. No
artifact owner or generic shared agent identity is inferred. `R3_URL`/`R3_TOKEN`
select remote transport. Other local configuration resolves environment, persisted
config, then defaults.

Local Claude Code/Codex create/publish makes the publisher the fallback in the
existing daemon. `listen` explicitly takes priority; `unlisten` removes the caller’s
registrations. Both fallback and explicit local listeners survive daemon restarts.
A Claude target requires a socket/token; Codex needs its thread and local executable
context. These are registered privately and used on Send, without proactive liveness
checks. A successful Codex queue may wait for the session to resume. Unsupported
agents can watch or poll. Remote `listen` retains its existing capability checks and
outward relay; automatic publication registration is currently local-only.

Watch exits 10 for pending feedback, 0 for archived, 2 for timeout, and 4 for a
superseded recipient or a snapshot conflict before acknowledgment. Archive takes precedence even if feedback is
pending or the timeout has just elapsed. Already archived watch returns immediately.
A nonblank archive message reaches the captured listener and remains in history;
blank messages produce no nudge. Restore needs a new registration. Notification
failure never rolls back lifecycle state and an operation-key retry never re-pushes.

## Delivery and status

Delivery is the owner's artifact-level handoff, not a receipt from every agent.
Agent messages start delivered. New human feedback/replies start pending; editing
an open human note clears its delivery timestamp. Editing a resolved note does not
reopen it. The private `ever_delivered` flag survives edits, so a subsequent human
status change still sets `statusUnsent` after any earlier delivery; resolving a
never-sent note does not create agent work. Agent messages remain born delivered
even if the human owner edits them.

`feedback fetch` and `watch` read pending feedback, await successful stdout
completion, then explicitly acknowledge that exact snapshot. Reads and failed output
leave content pending. A failed acknowledgment returns an error and may repeat output
on retry; concurrent conversation changes remain pending. This is at-least-once
handoff to stdout, not proof that the harness/model processed the content. Reusing an
old acknowledgment cannot drain a newer batch. All conversation mutations and
archive/restore advance a persisted artifact revision; claims alone do not.

After successful acknowledgment, `feedback fetch` registers the calling agent as an
explicit listener when harness detection supports it. This reuses local daemon
registration or the remote relay, returns after registration, and keeps listener
output off stdout. Setup failures only warn on stderr after a successful fetch.
Unsupported harnesses need no identity to fetch; `--human` skips registration.
`--all` reads open history without acknowledgment or registration, and
`--all --feedback` can read specific resolved threads too.
Wake notifications use the preferred `r3 feedback fetch` spelling. Fetch and watch
share a data-only formatter; workflow instructions live in the guide. Original
targets, claims, reply/fix context, status changes, and history pointers remain in
the payload. Without a listener/watcher, the browser offers **Use in agent** with a
copyable fetch command for `! <command>` in the harness. Opening/copying never
acknowledges feedback. Claims, publication, notifications, and event-stream reads
do not acknowledge feedback.

Feedback status is human-controlled. Replies carry no status or resolve action;
they release only the matching author's claim. Archive preserves unsent content
and accepts in-flight replies, while blocking publication, new claims, and normal
handoff. Thread originals stay readable even when a placement is unavailable.


## Conversation images

Message create/edit bodies accept `attachments`: an ordered list of up to four
`{ base64, mediaType, capture? }` new PNG/JPEG images or `{ id }` references retained
from that same message. Omission on edit preserves images; `[]` removes them. A
message requires nonblank text or an image. New note/reply bodies can include an
`operationKey`; identical retries return the existing message and changed input
conflicts. Message image routes use a 32 MiB streamed JSON bound, while individual
images are limited to 5 MiB and 20 megapixels. Ordinary route limits stay unchanged.

`GET/HEAD /api/artifacts/:id/attachments/:image` returns authenticated immutable
raster bytes after exact membership checks, with private no-store policy, nosniff,
same-origin resource policy, and no CORS capability. Pending/history responses
include the attachment manifest for the same messages represented in their text.
Preview `getThreads()` projects conversation text without attachment descriptors.

`feedback add` and `reply` accept repeatable `--attach <image>` and optional retry
`--key`; image-only messages may omit `-m`. `feedback edit --attach` replaces the
image list, and `--clear-attachments` removes it. `feedback image <artifact-id>
--image <image-id> [--output <file>]` downloads bytes; omitted output writes stdout.
`feedback fetch --attachments-dir <directory>` downloads and hash-verifies the
snapshot's images before output/acknowledgment, reusing only matching existing
files. Failure leaves feedback pending. The guide requires agents to open relevant
images with their harness's image viewer before replying.
