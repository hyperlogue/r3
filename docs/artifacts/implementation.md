# Artifact implementation

The [approved design](design.md) is the target. This checklist tracks delivery;
checked foundations do not imply the daemon, CLI, or browser has switched over.
The existing runtime remains in use until migration and the new clients are ready.

- [x] Public artifact/version/actor/native-target contract (`shared/artifacts.ts`).
- [x] Constrained destination schema with immutable published membership,
  original targets, and lifecycle history (`server/artifact-schema.ts`).
- [x] Immutable binary byte storage and corruption checks (`server/blobs.ts`).
- [x] Complete publication validation and atomic version publication, retry
  identity, sequence conflicts, retained rendering storage (`server/publication.ts`,
  `server/artifacts.ts`).
- [x] Standalone retained Markdown renderer (`server/artifact-document.ts`).
- [x] Sparse diff validation/rendering and captured-context expansion
  (`server/patch-content.ts`).
- [x] Native source/rendered/diff target validation and explicit message context
  (`server/artifact-targets.ts`).
- [x] Conversations, separate placements and human-controlled status
  (`server/artifact-conversations.ts`).
- [x] Feedback-scoped renewable claims with distinct agent owners.
- [x] Owner handoff and delivery tracking with atomic message snapshots.
- [x] Transactional archive/restore events and ordered retry identities
  (`server/artifact-lifecycle.ts`).
- [x] Message-dependent listener nudge and terminal watch behavior
  (`server/artifact-collaboration.ts`); remote transport wiring remains below.
- [x] Legacy database migration with explicit defaults, preserved IDs/evidence,
  reserved gaps, generated notices for empty publications, and restart recovery.
- [x] Publisher-side stable directory/git capture and one-time legacy local capture
  adapter (`cli/capture.ts`, `cli/capture-git.ts`, `server/migration-capture.ts`).
- [x] Private artifact-store bootstrap and publication-coordinated blob cleanup
  (`server/artifact-storage.ts`, `server/blobs.ts`).
- [ ] Switch daemon startup to artifact storage alongside the new clients.
- [x] Artifact HTTP routes, byte resource GET/HEAD/ranges, authenticated SSE and
  outward agent connection against injected storage (`server/artifact-api.ts`,
  `server/artifact-conversation-api.ts`). No filesystem dependencies in reads;
  daemon/client cutover is still separate.
- [ ] Publisher-side stable capture and upload, CLI commands, agent sessions,
  local harness wake adapters, remote listen/watch, help and guide.
  Command runner, help/guide and outward listener are implemented in
  `cli/artifact-commands.ts`, `cli/artifact-help.ts`, and
  `cli/artifact-listener.ts`; binary entrypoint/discovery cutover remains.
- [ ] Files workspace with source/rendered native targets and version switching;
  adapt existing diff presentation without losing sparse old/new targets.
  `web/src/pages/ArtifactView.tsx` composes the files/diff workspaces, pinned
  navigation, large-file Locate, and the rendered-pane interface. Browser stories
  verify draft retention, new-publication announcements, old-side context targets,
  and the collapsed composer. Actual rendered preview and router cutover remain.
- [ ] HTML workspace, isolated preview origin, scoped resource access, rendered
  comments, bridge utility, closed network enforcement and device delegation.
- [ ] Archive/restore browser controls, conversation/presence updates, mobile
  behavior, retained drafts and read progress, and component stories.
  These components and their workspace wiring are implemented and browser-tested;
  the production application still uses the earlier entry point.
- [ ] Updated demo fixtures/backend, README, AGENTS and deep-reference skills;
  remove obsolete review routes, commands and runtime modules after cutover.
- [ ] End-to-end local and remote workflows, legacy fixture migration, browser
  network/device tests, typecheck, tests, lint, binary/demo/Storybook builds.

## Browser isolation gate

A loopback HTTP/UDP probe against Chromium 151 found WebRTC STUN packets leaving
the document despite `connect-src 'none'; webrtc 'block'`. A real-time control
and restricted run both emitted packets. CSP alone is insufficient in that browser.
No executable artifact preview is enabled by these foundation commits.

The same loopback probe against Chrome for Testing 153.0.8010.36, with its default
feature flags, emitted four UDP packets in the control and none with
`Connection-Allowlist: (response-origin); webrtc=block; redirects=block`. The
restricted peer connection failed. Navigation, workers, version scoping, and
device permission still need browser acceptance tests before enabling previews.

The implemented `PreviewHost` gate now verifies URL blocking and WebRTC rejection
before granting a browser-bound partitioned cookie. A relay-only WebRTC check
without ICE servers yielded `new` without the policy and `failed` with it, with
zero packets in both cases. Partitioned cookie authentication worked in sandboxed
preview frames under localhost, loopback-IP, and localhost-subdomain application
origins. Against the real host, Chrome for Testing 153 passed the gate and loaded
published scripts and JSON; Chromium 151 reported unsupported and requested no
published files. The browser runtime/utility and broader acceptance matrix remain.

Evaluate [Connection Allowlists](https://wicg.github.io/connection-allowlists/)
alongside CSP and the isolated origin. Chromium's
[implementation design](https://chromium.googlesource.com/chromium/src/+show/main/docs/connection_allowlist_design.md)
covers navigation, worker, and WebRTC enforcement. Verify behavior in a supported
browser and fail closed when that enforcement is unavailable. The closed-network
contract remains required; camera/microphone retain ordinary browser consent.

## Completion criteria

All checklist items and the acceptance cases in the approved design must pass.
Old content must remain readable with the publisher offline, including binary
resources and retained Markdown. Uncertain migrated anchors must retain their
evidence. No version-removal or live-filesystem fallback may remain in the artifact
interface. No production database is used by development tests.
