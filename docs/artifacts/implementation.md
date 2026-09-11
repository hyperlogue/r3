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
- [ ] Message-dependent listener nudge and terminal watch behavior.
- [ ] Legacy database migration with explicit defaults, preserved IDs/evidence,
  reserved gaps, generated notices for empty publications, and restart recovery.
- [ ] Artifact HTTP routes, byte resource GET/HEAD/ranges, SSE and remote agent
  connection; remove filesystem dependencies from published-content reads.
- [ ] Publisher-side stable capture and upload, CLI commands, agent sessions,
  local harness wake adapters, remote listen/watch, help and guide.
- [ ] Files workspace with source/rendered native targets and version switching;
  adapt existing diff presentation without losing sparse old/new targets.
- [ ] HTML workspace, isolated preview origin, scoped resource access, rendered
  comments, bridge utility, closed network enforcement and device delegation.
- [ ] Archive/restore browser controls, conversation/presence updates, mobile
  behavior, retained drafts and read progress, and component stories.
- [ ] Updated demo fixtures/backend, README, AGENTS and deep-reference skills;
  remove obsolete review routes, commands and runtime modules after cutover.
- [ ] End-to-end local and remote workflows, legacy fixture migration, browser
  network/device tests, typecheck, tests, lint, binary/demo/Storybook builds.

## Browser isolation gate

A loopback HTTP/UDP probe against Chromium 151 found WebRTC STUN packets leaving
the document despite `connect-src 'none'; webrtc 'block'`. A real-time control
and restricted run both emitted packets. CSP alone is insufficient in that browser.
No executable artifact preview is enabled by these foundation commits.

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
