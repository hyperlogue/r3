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
| Publication validation, atomic visibility, retries, concurrent publishers, retained rendering, deduplicated content accounting, deletion | `server/publication.test.ts`, `server/artifacts.test.ts`, `server/blobs.test.ts`, `server/artifact-schema.test.ts` |
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
R3_TEST_BROWSER="$TEST_CHROMIUM" bun scripts/test-artifact-selection.ts
R3_TEST_BROWSER="$TEST_CHROMIUM" bun scripts/test-artifact-favicon.ts
R3_TEST_BROWSER="$TEST_CHROMIUM" bun scripts/test-markdown-theme.ts
R3_TEST_BROWSER="$TEST_CHROMIUM" bun scripts/test-feedback-interactions.ts
R3_TEST_BROWSER="$TEST_CHROMIUM" bun scripts/test-feedback-creation.ts
R3_TEST_BROWSER="$TEST_CHROMIUM" bun scripts/test-feedback-handoff.ts
R3_TEST_BROWSER="$TEST_CHROMIUM" bun scripts/test-preview-browser.ts
R3_TEST_BROWSER="$TEST_CHROMIUM" bun scripts/test-preview-workspace.ts
R3_TEST_BROWSER="$TEST_CHROMIUM" bun scripts/test-preview-cache.ts
R3_TEST_BROWSER="$TEST_CHROMIUM" bun scripts/test-markdown-cache.ts
R3_TEST_BROWSER="$TEST_CHROMIUM" bun scripts/test-passive-markdown.ts
R3_TEST_BROWSER="$TEST_CHROMIUM" bun scripts/test-preview-network.ts
R3_TEST_BROWSER="$TEST_FULL_CHROMIUM" bun scripts/test-preview-isolation.ts
R3_TEST_BROWSER="$TEST_FULL_CHROMIUM" R3_TEST_CAPTURE=1 bun scripts/test-preview-network.ts
R3_TEST_BROWSER="$TEST_UNSUPPORTED_CHROMIUM" R3_TEST_UNSUPPORTED=1 bun scripts/test-preview-browser.ts
R3_TEST_BROWSER="$TEST_UNSUPPORTED_CHROMIUM" R3_TEST_UNSUPPORTED=1 bun scripts/test-preview-network.ts
```

| Script | Acceptance boundary |
| --- | --- |
| `test-feedback-creation.ts` | Newest-first save, composer-to-card height transition, early event-stream reads and concurrent replies before the POST response, no duplicate cards, failed-save draft retention, retry, and reduced motion |
| `test-artifact-reading.ts` | Computed syntax colors for source/diff in light and dark modes; complete file stacks with progressive hydration; folding, file picking, and scroll-synchronized highlighting; delayed file hydration aligns below the toolbar without stealing newer jumps; on-demand feedback composer, draft handoff guard, and inactive shortcuts in hidden desktop/closed mobile panels; expanded/floating/hidden widths, remembered panel mode, and individual thread drafts with the dock hidden; Escape dismissal, keyboard reopening/general feedback, retained drafts, editor/popup priority, and repeat guards |
| `test-artifact-selection.ts` | Source/diff and rendered HTML/Markdown selection, unfocused composer, Space/Tab across the opaque frame, idle Escape, keyboard debounce, editable exclusions, quote destination and anchor preservation, native posted Markdown target, and touch action with selection collapse during the tap; comment-mode shortcuts in the workspace and preview, selected-node Space, native posted node targets, and repeat/modifier guards |
| `test-artifact-favicon.ts` | Agent feedback invalidations add a rendered blue favicon dot; human replies and resolution clear it; navigation restores the ordinary icon and reopening retains unhandled attention |
| `test-artifact-app.ts` | Copies the compiled binary outside the checkout; migrates an isolated legacy store; opens preserved URLs/threads; verifies backup and restart; exercises embedded assets, rendered human feedback, remote publication by another agent, pinned version selection, and Markdown/binary reads after deleting the publisher directory |
| `test-preview-browser.ts` | Capability gate, scoped resources, modules, utility RPC/subscriptions, element capture, contextual Locate, and normal page interaction; unsupported mode checks that no published file is requested |
| `test-markdown-theme.ts` | All four system/r3 theme combinations, live theme changes, retained syntax colors, unchanged authored HTML and stored bytes; full-height Markdown, fold/unfold reuse without document reload, width and late-image resizing, outer-pane Locate on mounted/new previews, reachable comment controls, and file-divider dragging over the opaque frame |
| `test-feedback-interactions.ts` | Held status responses, optimistic Resolve/Reopen, concurrent decisions and SSE replies, rollback of only the failed decision; directional queue slides, retained Active drafts, mode-transition reversal and reduced motion; stable typing and composer/card motion; reopening during an inert exit; floating-panel drag/resize over previews, independent dock width, saved geometry, clamping and keyboard controls; transient refetch recovery and definitive deletion |
| `test-feedback-handoff.ts` | Navbar sending with the panel hidden, shared navbar/panel in-flight guard, unhandled-only attention dots; held notification responses, Sending/Sent confirmation, duplicate suppression across reloads/tabs, concurrent inputs, out-of-order completions, retry and generic watch wakeups; agent activity does not create a pending batch; unavailable Web Crypto uses memory without persisting raw inputs |
| `test-preview-workspace.ts` | Actual workspace against temporary API/storage and automatic application-address previews: preview setup adds no browser history entry; artifact-scoped theme persistence through reload and version changes; rendered feedback in the shared thread, version switching, original-target Locate, and native published-document navigation |
| `test-preview-cache.ts` | HTTP revalidation for preview shells and trusted runtime scripts; persistent Markdown byte reuse after source switches, refresh, historical visits, and context replacement/renewal expiry; visible-only startup, retained frames, scroll restoration, repeated gate checks, opaque origins, deletion cleanup, real cross-tab logout and authenticated cache resumption. Accepts the same caller-installed Playwright engine settings as the compatibility suite |
| `test-markdown-cache.ts` | Real IndexedDB persistence, hash/identity checks, concurrent opens, LRU/expiry, oversized documents, cross-instance invalidation races, stale bootstrap responses, persisted cache suspension, corrupt bytes, reconnect cleanup, and storage failure. Uses the same Playwright engine settings |
| `test-passive-markdown.ts` | Passive formatting, theme, scroll and opaque isolation; hostile script/HTML/SVG/CSS inputs cannot initiate requests or navigate. Uses the same Playwright engine settings |
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
browser. The workspace runs the runtime gate before requesting publisher content;
the server authorizes bytes using the temporary context capability.
The compatibility suite passed on Linux in Chrome for Testing 153.0.8010.36
(verified blocking), Chromium 151.0.7922.173, and Playwright's patched Firefox 153.0
(consented compatibility). The external-access/device regression suite also passed
in Chrome for Testing 153 with synthetic devices and actual permission decisions.
These runs do not establish the full six-month release matrix or actual macOS/iOS
Safari coverage. No Safari platform acceptance has been run for this change.
See [preview security](../../.claude/skills/security-model/SKILL.md#preview-host)
for the enforced policy and scoped authorization.

A passing suite establishes the exercised scenarios, not the absence of defects.
Source and preview unit tests assert that conditional reads skip blob access and
that cached document validators cannot bypass membership, navigation guards, or revocation.
The compatibility and cache suites also assert that browser checks and reopening
documents require no server challenge exchange.
After removing the server challenge, compatibility checks passed in Chrome for
Testing 153.0.8010.36 and Playwright Firefox 153.0; Chromium cache and native
isolation checks also passed. These checks used fresh profiles and temporary stores.
The managed Markdown cache and passive reading suites passed in Chromium and
Firefox, including delayed authentication/verification, zero document-byte fetches
on warm hits across context replacement, native fragments, scroll preservation,
deletion cleanup, hostile passive markup, and cross-tab invalidation. Light/dark
cached-reading Storybook examples also rendered in Chromium. Safari remains untested.
Reproduce new failures with isolated fixtures and extend the relevant check.
Native iOS touch ergonomics remain the separate device-validation item tracked in
[the mobile reference](../../.claude/skills/mobile-tier/SKILL.md#owed).

## Demo, Storybook, and distribution

```sh
R3_DEMO_BASE=/r3/demo bun run build:demo
bun run stage:pages
R3_TEST_BROWSER="$TEST_CHROMIUM" bun scripts/test-artifact-demo.ts
R3_TEST_BROWSER="$TEST_CHROMIUM" bun scripts/test-demo-preview.ts
bun run build-storybook
```

The demo acceptance script serves the staged Pages output at `/r3/demo/`. It checks
home → files → feedback → Submit → scripted publication/reply, retained version
selection, and a deep-link reload with persisted history. Regenerate fixtures with
`bun run gen:demo` after changing canned content.

`test-demo-preview.ts` serves the built demo directly under the same prefix and
checks bundled HTML/CSS/images, opaque parent/storage isolation, a CSP-blocked
request to a controlled endpoint, internal document navigation, native text and
element feedback, Locate across documents, human resolution, scripted publication
with version pinning, rejection of executable bytes restored from localStorage,
full-height Markdown, retained frames after folding, theme changes, narrow layout,
and deep-link reloads. Demo preview stories are under `Demo/Previews`.

Chromium and Firefox were also exercised with fresh Playwright contexts for HTML
interaction/navigation, native text selection, feedback/publication/version
switching, Markdown height, and prefix reload. The locally available WebKit build
could not launch in the test environment; this is not branded Safari or iOS
acceptance evidence. Production gates, external access, device capture, and
arbitrary published content remain covered by the separate preview-server checks;
the static demo explicitly does not simulate their security guarantees.

For a commentable gallery of current components, run
`bun scripts/build-ui-showcase.ts`, then publish `dist/ui-showcase` as an HTML
artifact with entrypoint `index.html`. It includes feedback, file/diff stacks,
protection dialogs, and light/dark controls. Sample API calls use the in-memory
demo backend; display settings use memory in the opaque preview. The real
artifact's outer comment mode records UI review feedback. Rebuild and publish a
new version after component changes; existing publications remain immutable.

Build the interactive tutorial with `bun scripts/build-ui-tutorial.ts` and publish
`dist/ui-tutorial` as an HTML artifact. It imports the actual `ArtifactWorkspace`,
artifact list, file/diff viewers, feedback cards, and composer, using the scripted
demo backend for practice. Only the lesson guidance and sample document content
are tutorial-specific; it contains no parallel implementation of the review UI.
The sample document renders inline because an opaque publication cannot create a
nested preview iframe. Rendered exercise targets stay native to that sample, while
source and diff gestures use the production components. Practice navigation and
storage stay inside the tutorial; the outer artifact's comment mode reviews the
tutorial itself. Guide stories are under `Tutorial/Guide`.

The tutorial's opaque-sandbox browser check covers all six lessons, draft retention
through float/dock/hide, explicit agent handoff, pinned versions, manual resolution,
file folding and source display, both themes, narrow layout, and reset.

Storybook is the component and responsive-layout surface. For targeted interactive
runs, use the relevant workspace or component story; the compiled app and preview
scripts cover integration with the real server. The
[distribution reference](../../.claude/skills/build-and-distribution/SKILL.md) owns
binary embedding, CSS compilation, demo aliases, and Pages layout.

Workspace and component stories expose desktop and mobile states for visual review.
`ReopenDuringExit` exercises focus while an earlier composer is still leaving;
`SettingsFromMenu` and `KeyboardDismiss` cover menu placement and focus restoration.
