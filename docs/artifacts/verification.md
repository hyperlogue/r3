# Artifact verification

Use this guide when changing publication, targeting, collaboration, migration,
preview isolation, or distribution. The [design](design.md) owns product behavior;
the [schema reference](schema.md) owns persistence rules. This guide maps those
boundaries to executable checks.

The [browser support requirement](browser-support.md) defines the rolling
six-month release window and the evidence needed for Firefox, Chrome, and actual
Safari on macOS and iOS. The Chromium runs below do not establish that coverage.

## Repository checks

```sh
bun run typecheck
bun test
biome check .
```

Tests inject temporary storage or isolate subprocess XDG directories. They must
never migrate, restart, or read the normal user daemon/database for verification.
The tests and scripts are the maintained source of acceptance coverage; completed
implementation checklists and historical test counts are kept in Git history.

| Boundary | Checks |
| --- | --- |
| Complete directory capture, stable Git inputs, binary bytes | `cli/capture.test.ts`, `cli/capture-git.test.ts`, `cli/artifact-publish.test.ts` |
| Publication validation, atomic visibility, retries, concurrent publishers, retained rendering, deletion | `server/publication.test.ts`, `server/artifacts.test.ts`, `server/blobs.test.ts`, `server/artifact-schema.test.ts` |
| Source/rendered/diff targets, explicit reply context, independent placements | `server/artifact-targets.test.ts`, `server/artifact-conversations.test.ts`, `web/src/artifact-navigation.test.ts` |
| Claims, owner delivery, archive races/messages, terminal watch, outward listeners | `server/artifact-collaboration.test.ts`, `server/artifact-lifecycle.test.ts`, `server/agent-connections.test.ts`, `cli/artifact-listener.test.ts`, `cli/artifact-commands.test.ts` |
| Legacy identity/content/evidence, defaults, backup, failed/interrupted upgrade, reopen | `server/migration*.test.ts`, `server/artifact-storage.test.ts` |
| Authenticated API/SSE, full-origin checks, resource bytes/ranges, scoped preview access | `server/artifact-api.test.ts`, `server/artifact-auth.test.ts`, `server/artifact-resources.test.ts`, `server/preview-*.test.ts` |
| Draft retention, version selection, source/diff Locate, folded composer, phone layout | `web/src/artifact-*.test.ts`, `web/src/pages/ArtifactView.stories.tsx`, `ArtifactHome.stories.tsx`, component stories |
| Device constraints, stale/pending permission results, capture shutdown, bounded RTC answers | `web/src/preview-capture.test.ts` |
| Demo owner edits, delivery, claims, publication and archive behavior | `web/demo/artifact-api.test.ts`, `web/demo/artifact-backend.test.ts` |

## Browser and compiled-binary acceptance

Browser checks use `scripts/browser.ts` with fresh profiles and controlled local
endpoints. Set `TEST_CHROMIUM` to a headless Chromium shell executable,
`TEST_FULL_CHROMIUM` to a full Chromium executable for permission tests, and
`TEST_UNSUPPORTED_CHROMIUM` to a browser expected to fail the preview gate.

```sh
bun run build
R3_TEST_BROWSER="$TEST_CHROMIUM" bun scripts/test-artifact-app.ts
R3_TEST_BROWSER="$TEST_CHROMIUM" bun scripts/test-artifact-reading.ts
R3_TEST_BROWSER="$TEST_CHROMIUM" bun scripts/test-preview-browser.ts
R3_TEST_BROWSER="$TEST_CHROMIUM" bun scripts/test-preview-workspace.ts
R3_TEST_BROWSER="$TEST_CHROMIUM" bun scripts/test-preview-network.ts
R3_TEST_BROWSER="$TEST_FULL_CHROMIUM" bun scripts/test-preview-isolation.ts
R3_TEST_BROWSER="$TEST_FULL_CHROMIUM" R3_TEST_CAPTURE=1 bun scripts/test-preview-network.ts
R3_TEST_BROWSER="$TEST_UNSUPPORTED_CHROMIUM" R3_TEST_UNSUPPORTED=1 bun scripts/test-preview-browser.ts
R3_TEST_BROWSER="$TEST_UNSUPPORTED_CHROMIUM" R3_TEST_UNSUPPORTED=1 bun scripts/test-preview-network.ts
```

| Script | Acceptance boundary |
| --- | --- |
| `test-artifact-reading.ts` | Computed syntax colors for source/diff in light and dark modes; complete file stacks with progressive hydration; folding, file picking, and scroll-synchronized highlighting; delayed file hydration aligns below the toolbar without stealing newer jumps; on-demand feedback composer, draft handoff guard, and inactive shortcuts in folded desktop/closed mobile panels |
| `test-artifact-app.ts` | Copies the compiled binary outside the checkout; migrates an isolated legacy store; opens preserved URLs/threads; verifies backup and restart; exercises embedded assets, rendered human feedback, remote publication by another agent, pinned version selection, and Markdown/binary reads after deleting the publisher directory |
| `test-preview-browser.ts` | Capability gate, scoped resources, modules, utility RPC/subscriptions, element capture, contextual Locate, and normal page interaction; unsupported mode checks that no published file is requested |
| `test-preview-workspace.ts` | Actual workspace against temporary API/storage and automatic application-address previews: preview setup adds no browser history entry; artifact-scoped theme persistence through reload and version changes; rendered feedback in the shared thread, version switching, original-target Locate, and native published-document navigation |
| `test-preview-network.ts` | HTML-only network control in the nav security popover and modal shortcut suspension; protected default, cancellation, external script loading and transmission of fixture content/conversations to a controlled endpoint; retained sandbox and real app API rejection, including after external navigation to a document with workers and nested frames; context revocation, native navigation, version/reload reset; explicit opt-out in a browser that refuses protected rendering; `R3_TEST_CAPTURE=1` adds real browser denial/grant, received audio/video, independent physical track and clone shutdown, Stop sharing, stale consent dialog dismissal, navigation/version revocation, and unresponsive-page shutdown/recovery |
| `test-preview-compatibility.ts` | Actual capability gate and workspace in caller-installed Playwright engines: no publication bytes before consent, one warning and one aggregate nav indicator for concurrent media previews, decline/reopen, remembered acknowledgment, cross-tab revocation, storage-write failure, verified blocking despite saved acknowledgment, publisher gate-message forgery rejection, restrictive CSP, accurate external-navigation disclosure, app isolation, interaction/feedback, native navigation, versions, rendered files, and recovery that refuses transport errors |
| `test-preview-isolation.ts` | Native modules/CSS/fetch/XHR/media, video/audio seeking and ranges, two opaque frames on the application address, parent/sibling/storage and cookie isolation, denied workers and frames, blocked external resources/navigation/redirects/sockets/WebRTC, and denied capture even after a transport-origin device grant |

The compatibility suite uses an existing `playwright-core` package without adding
or downloading dependencies. Set `R3_TEST_PLAYWRIGHT` to its entry module,
`R3_TEST_ENGINE` to `chromium`, `firefox`, or `webkit`, and `R3_TEST_BROWSER` to the
matching executable. Use `R3_TEST_UNSUPPORTED=1` for engines expected to require
the compatibility warning. `R3_TEST_SCREENSHOT` optionally captures desktop,
phone-sized warning, and protection details. Engine tests and resized viewports
do not establish actual Safari or iOS support.

The permission test uses synthetic devices and browser permission overrides. It
needs full Chromium: the headless shell's fake media UI cannot prove denial. No
physical camera or microphone is read. Direct native opaque-document capture must
stay denied even after a transport-origin grant. Protected previews retain all
network and device restrictions. HTML external-mode capture requires separate r3
device consent even when the browser remembers a grant; test its relay with actual
video frames and received audio bytes, and inspect the parent-owned physical tracks
for shutdown. Browser acceptance must not substitute a fake resolved stream for
native permission decisions.

Reference runs on 2026-09-12 passed in Chrome for Testing 153.0.8010.36. Chromium
151 was refused before requesting published files. Its CSP-only WebRTC probe had
emitted packets; Connection Allowlist enforcement prevented them in the supported
browser. Browser identity alone never enables preview: the runtime gate must pass.
The compatibility suite passed on Linux in Chrome for Testing 153.0.8010.36
(verified blocking), Chromium 151.0.7922.173, and Playwright's patched Firefox 153.0
(consented compatibility). The external-access/device regression suite also passed
in Chrome for Testing 153 with synthetic devices and actual permission decisions.
These runs do not establish the full six-month release matrix or actual macOS/iOS
Safari coverage. No Safari platform acceptance has been run for this change.
See [preview security](../../.claude/skills/security-model/SKILL.md#preview-host)
for the enforced policy and scoped authorization.

A passing suite establishes the exercised scenarios, not the absence of defects.
Reproduce new failures with isolated fixtures and extend the relevant check.
Native iOS touch ergonomics remain the separate device-validation item tracked in
[the mobile reference](../../.claude/skills/mobile-tier/SKILL.md#owed).

## Demo, Storybook, and distribution

```sh
R3_DEMO_BASE=/r3/demo bun run build:demo
bun run stage:pages
R3_TEST_BROWSER="$TEST_CHROMIUM" bun scripts/test-artifact-demo.ts
bun run build-storybook
```

The demo acceptance script serves the staged Pages output at `/r3/demo/`. It checks
home → files → feedback → Submit → scripted publication/reply, retained version
selection, and a deep-link reload with persisted history. Regenerate fixtures with
`bun run gen:demo` after changing canned content. The static demo explicitly declines
executable previews because it has no isolated daemon host.

For a commentable gallery of current components, run
`bun scripts/build-ui-showcase.ts`, then publish `dist/ui-showcase` as an HTML
artifact with entrypoint `index.html`. It includes feedback, file/diff stacks,
protection dialogs, and light/dark controls. Sample API calls use the in-memory
demo backend; display settings use memory in the opaque preview. The real
artifact's outer comment mode records UI review feedback. Rebuild and publish a
new version after component changes; existing publications remain immutable.

Storybook is the component and responsive-layout surface. For targeted interactive
runs, use the relevant workspace or component story; the compiled app and preview
scripts cover integration with the real server. The
[distribution reference](../../.claude/skills/build-and-distribution/SKILL.md) owns
binary embedding, CSS compilation, demo aliases, and Pages layout.

The reading acceptance also checks that the composer precedes the threads and
the expanded desktop panel reserves content space. Floating and hidden retain the
same content width. The flush collapsed rail has one full-area control; clicking
its empty bottom or pressing `p` restores the last visible mode, including after
a reload. Selecting a source anchor
with the panel hidden opens one thread, and dismissing/reopening it
preserves its reply draft. Workspace and popover stories expose the same states
for visual review; mobile keeps its sheet.
