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

- `GET/POST /api/sessions` lists/registers explicit agent identities;
  `GET/POST /api/projects` and `DELETE /api/projects/:id` manage optional grouping.
  Removing a group preserves its artifacts.
- `GET/POST /api/artifacts`, `GET/PATCH/DELETE /api/artifacts/:id` list, create,
  inspect, edit metadata, or delete the whole artifact. List filters are `state`,
  `kind`, `project`, and `meta.<key>`. No repo header or local path is involved.
  Artifact reads include computed `unhandledCount`: open threads whose latest
  message is from an agent. Reading, delivery, and claims do not clear it.
  `storage.totalBytes` and `storage.latestVersionBytes` report deduplicated published
  content and the latest publication's full footprint, excluding database/filesystem
  overhead. See [storage accounting](../../../docs/artifacts/schema.md#content-storage-accounting).
  Artifact metadata has no overview/summary field. Publication summaries remain
  immutable version metadata; `edit --summary` is unsupported.
- `GET/POST /api/artifacts/:id/versions` lists retained versions or publishes a
  complete version with `expectedSeq`, `publicationKey`, and explicit `actor`.
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
  `artifact_summary` and `version_summary` are historical read-only targets;
  new feedback, reply fix targets, and placements reject description anchors.
- `POST/DELETE /api/claims { sessionId, feedbackIds }` claims/releases as the
  named registered agent. Claims change presence, not owner delivery.
- `GET .../:id/prompt[?scope=unsent&feedback=<ids>]` is read-only;
  `POST .../:id/prompt { feedback? }` drains the exact pending snapshot.
  Both return text with `x-r3-prompt-items`; only POST stamps delivery.
  An unsent preview also returns `x-r3-prompt-fingerprint`. Manual copy sends it
  back as `expectedFingerprint` after clipboard success; a changed snapshot
  returns 409 without stamping newly edited content. Direct CLI drains omit it.
- `POST .../:id/submit` returns `{ notification }`; `sent` confirms a local harness
  delivery acknowledgment or a generic watch woken for pending feedback. An absent
  recipient (or a watch with no pending work) returns `none`. Neither drains feedback.
  `POST .../:id/lifecycle` takes `ArtifactLifecycleBody`, returning the persisted
  event, replay flag, and notification result. Delivery failure is HTTP 502;
  the committed archive remains authoritative. Replays do not notify twice.
- `GET .../:id/watchers`, `POST .../:id/watch { actor, timeoutMs? }`, and
  `POST .../:id/listen { actor }` share one designated recipient slot. Watch is
  bounded long polling; listen is an outward SSE connection from the publisher.
  `POST /api/connections/:id/acknowledgments` acknowledges local harness delivery.
  The server receives no harness socket, executable path, or harness credential.
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
flags reject cross-representation guesses. `--session` or `R3_AGENT_SESSION`
supports any harness; no generic shared `agent` identity is invented.

`cli/artifact-listener.ts` owns local wake adapters and the outward connection.
It acknowledges after a successful socket write or queue exit, never after
receiving a frame alone. Harness diagnostics stay local; the acknowledgment
contains a generic failure. The background launcher waits for an IPC readiness
message before returning, inherits credentials locally, and never writes them to
argv or a temporary file. A closed connection requires fresh registration.

## Preview and bootstrap routes

- `POST /api/artifacts/:id/versions/:seq/previews { path, network? }` creates a scoped
  preview context. `network` defaults to `blocked`. `compatible` retains restrictive
  headers while skipping proof of network enforcement; the browser chooses it only
  after risk consent. Only `html` artifacts accept `external`. Invalid modes and
  non-HTML external exceptions return 400. The response reports
  the immutable mode. `PATCH /api/previews/:id` renews expiry without changing policy;
  `DELETE` revokes it. Changing policy requires a new context.
  The response contains scoped gate/document/utility URLs and `resourceRoot`,
  never application credentials. `origin` is the transport origin; rendered
  documents have opaque origins.
- `GET /api/health` reports version and `protocol: artifacts-v1`; `GET /api/boot`
  supplies local bootstrap or required-login state. Both remain Host/origin gated.
- `POST /api/auth/login { token }` mints a browser session; `POST /api/auth/logout`
  destroys it. `GET/POST/DELETE /api/auth/tokens` and `DELETE .../tokens/:id`
  manage revocable login tokens. Current-session individual revocation conflicts.
- `GET /api/themes` and `GET /api/theme-style?theme=` return available themes and
  the shared source palette stylesheet.

The preview dispatcher serves its own gate, resources and runtime under
`/__r3_preview/:context/files/` and `/__r3_preview/:context/r3/`. Automatic hosting
uses the Host-guarded application listener; an explicit endpoint adds a separate
loopback preview listener. It serves no application API, proxy, or unknown-path SPA fallback. See
[security-model](../security-model/SKILL.md) for its authorization boundary.

The browser-only `ArtifactUtility` in `shared/preview-protocol.ts` also exposes
`getUserMedia(constraints): Promise<MediaStream>`. The external-mode runtime adapts
the standard `navigator.mediaDevices.getUserMedia` call to the same device relay.
Only an HTML page with explicit current-document device consent can request it;
browser permission is independent. There is no device HTTP endpoint or grant in
publication/preview metadata. The [security model](../security-model/SKILL.md)
owns the parent capture lifecycle and narrow RTC protocol; the README documents
supported constraints and track compatibility.

## CLI and agent loop

`r3 guide` and `r3 --help` come from `cli/artifact-help.ts`; keep both accurate in
any change to commands, flags, results, or protocol. The current command families:

| Commands | Contract |
| --- | --- |
| `create`, `publish` | Local stable capture, complete binary-safe upload; fixed kind, explicit retry key and expected latest publication |
| `list`, `show`, `versions`, `files`, `source`, `download`, `patch` | Read only; content reads name a version; downloads preserve original bytes |
| `edit`, `delete` | Artifact metadata or whole-artifact deletion; no individual version mutation |
| `feedback add/edit/delete`, `reply`, `place` | Native immutable originals, explicit reply context, separate placements; `--human` required for status edits |
| `claim`, `release` | Registered session owns a renewable feedback-scoped lease |
| `prompt`, `watch`, `listen` | Owner handoff and one designated outward recipient |
| `archive`, `restore` | Ordered retained lifecycle events, optional archive message, retry operation key |
| `project list/create/delete` | Optional grouping, independent of Git paths |
| `auth`, `config`, `start/stop/status/restart`, `guide` | Browser login management, local configuration and daemon lifecycle |

Directory capture defaults to files, never inferred HTML. `--kind html` requires
one selected root index; `--entrypoint` disambiguates two. Diff capture flags select
working tree, index, commit, range, or stdin patch. Every version is complete and
independent. `--ref`/`--file` captures retained Git bytes on the publisher.

Use a distinct `--session` or `R3_AGENT_SESSION` per logical agent; the harness may
supply it automatically. The client registers that session before writes. No
artifact owner or generic shared agent identity is inferred. `R3_URL`/`R3_TOKEN`
select remote transport. Other local configuration resolves environment, persisted
config, then defaults.

`listen` uses local adapters and returns after an IPC-ready acknowledgment. A
Claude socket needs its authenticated messaging token; Codex requires a successful
local `codex queue --help` probe. Missing support is exit 5 and `watch` remains
available to any harness. The remote daemon never runs either adapter.

Watch exits 10 for pending feedback, 0 for archived, 2 for timeout, and 4 for a
conflicting or superseded recipient. Archive takes precedence even if feedback is
pending or the timeout has just elapsed. Already archived watch returns immediately.
A nonblank archive message reaches the captured listener and remains in history;
blank messages produce no nudge. Restore needs a new registration. Notification
failure never rolls back lifecycle state and an operation-key retry never re-pushes.

## Delivery and status

Delivery is the owner's artifact-level handoff, not a receipt from every agent.
Agent messages start delivered. New human feedback/replies start pending; editing
an open human note clears its delivery timestamp. Editing a resolved note does not
reopen it. Human status changes after delivery set `statusUnsent`; resolving a
never-sent note does not create agent work. Agent messages remain born delivered
even if the human owner edits them.

A prompt POST drains selected pending content atomically. `prompt --all` is a
read-only view of open history. The browser's manual-copy path conditionally
acknowledges the exact copied snapshot; failed clipboard writes or changed content
leave it pending. Claims, publication, notifications, and event-stream reads do
not acknowledge feedback.

Feedback status is human-controlled. Replies carry no status or resolve action;
they release only the matching author's claim. Archive preserves unsent content
and accepts in-flight replies, while blocking publication, new claims, and normal
handoff. Thread originals stay readable even when a placement is unavailable.
