# Artifact implementation

The [approved design](design.md) is the target. This checklist tracks delivery;
the daemon, CLI, browser, and static demo now use the artifact protocol. The
implementation and acceptance work below is complete; deployment and release are
separate operations.

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
  (`server/artifact-collaboration.ts`).
- [x] Legacy database migration with explicit defaults, preserved IDs/evidence,
  reserved gaps, generated notices for empty publications, and restart recovery.
- [x] Publisher-side stable directory/git capture and one-time legacy local capture
  adapter (`cli/capture.ts`, `cli/capture-git.ts`, `server/migration-capture.ts`).
- [x] Private artifact-store bootstrap and publication-coordinated blob cleanup
  (`server/artifact-storage.ts`, `server/blobs.ts`).
- [x] Switch daemon startup to artifact storage alongside the new clients.
- [x] Artifact HTTP routes, byte resource GET/HEAD/ranges, authenticated SSE and
  outward agent connection against injected storage (`server/artifact-api.ts`,
  `server/artifact-conversation-api.ts`). No filesystem dependencies remain in ordinary reads.
- [x] Publisher-side stable capture and upload, CLI commands, agent sessions,
  local harness wake adapters, remote listen/watch, help and guide.
  Command runner, help/guide and outward listener are implemented in
  `cli/artifact-commands.ts`, `cli/artifact-help.ts`, and
  `cli/artifact-listener.ts`; the binary dispatches through `artifact-main.ts`.
- [x] Files workspace with source/rendered native targets and version switching;
  adapt existing diff presentation without losing sparse old/new targets.
  `web/src/pages/ArtifactView.tsx` composes the files/diff workspaces, pinned
  navigation, large-file Locate, and the rendered-pane interface. Browser stories
  verify draft retention, new-publication announcements, old-side context targets,
  and the collapsed composer. `ArtifactPreview` now connects the isolated host,
  rendered targeting, utility, media previews, and native document navigation.
  The production router opens both new artifact IDs and preserved review IDs.
- [x] HTML workspace, isolated preview origin, scoped resource access, rendered
  comments, bridge utility, closed network enforcement and device delegation.
- [x] Archive/restore browser controls, conversation/presence updates, mobile
  behavior, retained drafts and read progress, and component stories.
  These components and their workspace wiring are implemented and browser-tested.
- [x] Updated demo fixtures/backend, README, AGENTS and deep-reference skills;
  remove obsolete review routes, commands and runtime modules after cutover.
- [x] End-to-end local and remote workflows, legacy fixture migration, browser
  network/device tests, typecheck, tests, lint, binary/demo/Storybook builds.

## Browser isolation gate

A loopback HTTP/UDP probe against Chromium 151 found WebRTC STUN packets leaving
the document despite `connect-src 'none'; webrtc 'block'`. A real-time control
and restricted run both emitted packets. CSP alone is insufficient in that browser.
This finding ruled out CSP-only preview enforcement. Unsupported browsers are
refused before receiving published executable content.

The same loopback probe against Chrome for Testing 153.0.8010.36, with its default
feature flags, emitted four UDP packets in the control and none with
`Connection-Allowlist: (response-origin); webrtc=block; redirects=block`. The
restricted peer connection failed. The complete navigation, worker, version
scoping, and device permission acceptance runs below subsequently passed.

The implemented `PreviewHost` gate now verifies URL blocking and WebRTC rejection
before granting a browser-bound partitioned cookie. A relay-only WebRTC check
without ICE servers yielded `new` without the policy and `failed` with it, with
zero packets in both cases. Partitioned cookie authentication worked in sandboxed
preview frames under localhost, loopback-IP, and localhost-subdomain application
origins. Against the real host, Chrome for Testing 153 passed the gate and loaded
published scripts and JSON; Chromium 151 reported unsupported and requested no
published files.

`scripts/test-preview-browser.ts` verifies the gate, modules, utility RPC and
subscriptions, click interception before publisher handlers, native target
capture, contextual repeated-quote Locate, and normal interaction. Set
`R3_TEST_BROWSER` to the test Chromium executable; add `R3_TEST_UNSUPPORTED=1`
for a browser that must be refused. `scripts/test-preview-workspace.ts` builds
the real workspace and tests it against temporary artifact/API/preview servers:
human utility feedback, the shared panel thread, version switching, native Locate,
and published-document navigation. Both use fresh browser profiles and stores.

`scripts/test-preview-isolation.ts` passed in the full Chrome for Testing
153.0.8010.36 build. It checks native modules, CSS, fetch/XHR, images, audio
and video seeking (including native media Range requests), worker requests, and
binary ranges; blocks external scripts, styles, fonts, images, media, frames,
forms, popups, parent/direct navigation, redirects,
WebSocket/WebTransport, unrelated application/version requests, and WebRTC UDP;
and checks inherited restrictions in blob/srcdoc/rewritten documents. Camera and
microphone deny/grant overrides use the browser's
[permission API](https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-setPermission)
with fake devices, followed by another blocked WebRTC attempt. Use a full Chromium
build for this script: the headless shell's fake media UI bypasses permission
overrides and cannot verify denial.

Evaluate [Connection Allowlists](https://wicg.github.io/connection-allowlists/)
alongside CSP and the isolated origin. Chromium's
[implementation design](https://chromium.googlesource.com/chromium/src/+show/main/docs/connection_allowlist_design.md)
covers navigation, worker, and WebRTC enforcement. Verify behavior in a supported
browser and fail closed when that enforcement is unavailable. The closed-network
contract remains required; camera/microphone retain ordinary browser consent.

## End-to-end acceptance and distribution

`scripts/test-artifact-app.ts` copies the compiled binary outside the checkout and
runs it with temporary XDG directories and storage. It creates a legacy database,
triggers migration through the real lazy-start CLI, opens the retained review URL
and conversation in Chromium, checks the private backup, and restarts without
re-importing. The same run verifies embedded application assets, the isolated HTML
runtime, a human utility-created thread visible to CLI and panel, a second logical
agent publishing through an explicit remote URL/credential, pinned version 1 after
version 2 arrives over SSE, and Markdown/binary reads after deleting the publisher
directory. The normal user daemon/database is never touched.

`scripts/test-artifact-demo.ts` serves staged Pages output under `/r3/demo/` and
checks home → files → human feedback → Submit → scripted publication/reply, retained
version selection, and deep-link reload with browser-persisted history. The demo
uses production API types; tests cover human owner edits, selected delivery,
claims, presence, archive during in-flight work, and fresh registration rules.

The final core suite passes **230 tests across 52 files**, with typecheck and Biome
clean. Binary compilation, demo build, Pages staging, and Storybook build pass.
Real-browser component runs cover desktop/mobile home, draft retention, folded
composer, source/diff native Locate, and large virtualized files. The browser
security matrix passes in full Chrome for Testing 153.0.8010.36; Chromium 151
fails closed as expected. Native iOS touch ergonomics remain a separate device
validation item in the mobile skill; unsupported executable previews stay disabled.

Reproduce the acceptance runs with a supported test browser executable:

```sh
bun run typecheck
bun test
biome check .
bun run build
R3_TEST_BROWSER="$TEST_CHROMIUM" bun scripts/test-artifact-app.ts
R3_TEST_BROWSER="$TEST_CHROMIUM" bun scripts/test-preview-browser.ts
R3_TEST_BROWSER="$TEST_CHROMIUM" bun scripts/test-preview-workspace.ts
R3_TEST_BROWSER="$TEST_FULL_CHROMIUM" bun scripts/test-preview-isolation.ts
R3_TEST_BROWSER="$TEST_UNSUPPORTED_CHROMIUM" R3_TEST_UNSUPPORTED=1 bun scripts/test-preview-browser.ts
R3_DEMO_BASE=/r3/demo bun run build:demo
bun run stage:pages
R3_TEST_BROWSER="$TEST_CHROMIUM" bun scripts/test-artifact-demo.ts
bun run build-storybook
```

The app/workspace acceptance scripts were run with the headless Chromium shell;
the isolation script needs a full Chromium build for real permission overrides.
All use synthetic documents, fresh browser profiles, temporary stores, and
controlled local endpoints. Tests do not access physical camera/microphone devices.

## Delivered boundaries

Published bytes and retained Markdown remain readable with the publisher offline.
Uncertain migrated anchors retain their evidence; missing sequences are reserved.
All versions remain available until whole-artifact deletion. No old review API,
individual version removal, or live-filesystem fallback remains in the application.
Legacy type adapters and renderer fixtures are explicitly separate from the active
artifact contract.

Rendering is enabled only after the browser enforcement gate succeeds. Remote
rendering requires a configured HTTPS preview origin and wildcard context routing.
External network access, automatic builds/dependency installation, backend hosting,
root-relative rewriting/history fallback, multi-user permissions, and recipient
fan-out remain outside the approved feature scope.
