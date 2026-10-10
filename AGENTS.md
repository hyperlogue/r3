# r3 — Render. Review. Refine.

r3 is a local-first workspace for **published artifacts and human/agent
conversations**. A per-user server owns immutable content and persisted discussions;
the browser, CLI, and agents use the same HTTP/JSON contract. The server, worker,
CLI, and SPA ship as one self-contained binary. Read [README.md](README.md) for usage.

Write README.md for human readers evaluating and getting started with r3. Keep
agent instructions, protocol semantics, and exhaustive feature details in the
agent guide or reference documentation.

Use [CONTEXT.md](CONTEXT.md) for domain terminology. Backend names the entity;
server and notification worker name its storage and local notification roles.
Subscription names notification routing state; selected subscription names the
one currently chosen. Existing protocol fields retain their wire spellings.

This file, the [artifact design](docs/artifacts/design.md),
[schema explanation](docs/artifacts/schema.md), and the deep-reference skills below
are the design source of truth. Update the document that owns a decision when it
changes. [Verification](docs/artifacts/verification.md) maps behavior to executable
acceptance checks. Earlier live-file reviews have been retired; imported historical
evidence remains readable but does not define new API behavior.

## Architecture

The HTTP/JSON contract is the product. Start at `shared/artifacts.ts` (re-exported
by `shared/types.ts`), then `server/artifact-api.ts`, `cli/artifact-commands.ts`,
and `web/src/artifact-api.ts`. Keep all three clients aligned.

```text
publisher: capture local files/git → CLI HTTP upload ─┐
browser: fetch + authenticated event stream ──────────┼→ backend server
agent: CLI/HTTP publications, discussions, claims ───────┘    SQLite + immutable blobs
local agent harness ← persistent worker ← outward stream ← selected backend
opaque preview document → scoped version bytes + trusted r3 runtime
```

- The server is the only SQLite writer. Storage and domain services are explicitly
  constructed and injected; importing modules must not open a database.
- Ordinary requests use artifact/version identity. The server never resolves a
  publisher path, Git repository, worktree, or live file. Git and directory capture
  run on the publisher. Direct upgrades from live-review stores require r3 1.5.0
  first; current startup upgrades only artifact schemas.
- Projects are optional groups, assigned explicitly or inferred from a sanitized
  publisher-supplied Git remote under server policy. Their IDs do not derive from
  paths or URLs. Later publications preserve the group; deletion preserves artifacts.
- One logical agent session identifies one run. Multiple agents, including
  subagents, use distinct IDs. Sessions are attribution, not credentials, accounts,
  artifact ownership, or live presence.
- Local mode starts the same backend server lazily and announces it in
  `$XDG_RUNTIME_DIR/r3/daemon.json`. A private Unix sidecar bootstraps local CLI
  credentials; `r3 open` supplies a one-time browser link. Browser boot never exposes
  the API credential. Backend selection is `R3_URL`, nearest project
  `.r3.json`, user `backendUrl`, then automatic local. Saved credentials are keyed
  by the complete normalized URL; `r3 login` supports browser approval or an API key.
  The separate persistent worker opens only private Unix IPC and outgoing backend
  streams. CLI data/watch go directly to the backend. Read
  [remote protocol](docs/artifacts/remote-protocol.md) for auth, recovery, and wire rules.
- The loopback application listener dispatches scoped preview paths separately
  from its authenticated API. Previews use the browser's r3 address automatically;
  every rendered document has an opaque browser origin and no application
  credentials.
  App HTML downloads are attachments; the workspace checks browser capabilities
  and obtains any required consent before loading executable documents.
- SSE carries invalidations after committed writes. Clients refetch state on ready
  or reconnect. No filesystem watcher or live-content fallback remains.

## Module map

| Area | Modules and responsibility |
| --- | --- |
| Public contracts | `shared/artifacts.ts`, `artifact-client.ts`, `artifact-prompt.ts`, `preview-protocol.ts`, `event-stream.ts`; `shared/types.ts` adds renderer, bootstrap, and publisher wake shapes |
| Entrypoints | `cli/index.ts` → `artifact-main.ts`; `server/index.ts` → `artifact-daemon.ts`; `web/src/App.tsx` → `ArtifactHome` / `ArtifactView` |
| Bootstrap and exposure | `server/config.ts`, `artifact-config.ts`, `artifact-daemon.ts`, `artifact-server.ts`, `application-assets.ts`; `cli/daemon-client.ts`, `artifact-settings.ts` |
| Store and upgrade | `server/artifact-storage.ts`, `artifact-schema.ts`, `blobs.ts`, `migration.ts`; private backup, atomic migration, recovery, coordinated garbage collection |
| Publication | `server/artifacts.ts`, `publication.ts`, `artifact-validation.ts`; stable upload identity, preparation before atomic publish, immutable membership |
| Project grouping | `server/artifact-projects.ts`, `shared/git-remote.ts`; remote identities, explicit overrides, configured aliases, conditional metadata updates; terms in [CONTEXT.md](CONTEXT.md) |
| Publisher capture | `cli/capture.ts`, `capture-git.ts`, `publisher-remote.ts`, `artifact-publish.ts`; bounded stable bytes, sanitized remote hints, Git process isolation, explicit retry diagnostics |
| Content and rendering | `server/artifact-source.ts`, `artifact-resources.ts`, `artifact-document.ts`, `patch-content.ts`; `git.ts` is a pure patch parser/trimmer |
| Native targeting | `server/artifact-targets.ts`, `artifact-conversations.ts`; original targets and historical placements |
| Collaboration | `server/artifact-lifecycle.ts`, `artifact-collaboration.ts`, `artifact-events.ts`; events, handoff, claims, selected recipient |
| HTTP and auth | `server/artifact-api.ts`, `artifact-conversation-api.ts`, `artifact-http.ts`, `artifact-auth.ts`, `auth.ts`, `client-auth.ts`, `client-auth-api.ts`; `cli/backend.ts`, `login.ts`, `private-state.ts` |
| Wake delivery | `cli/worker-runtime.ts`, `worker-client.ts`, `shared/worker-protocol.ts`; persistent worker, private local targets, outgoing streams; `server/worker-connections.ts`, `worker-records.ts` own opaque routing and retirement; `artifact-listeners.ts` preserves migration inputs |
| Preview server | `server/preview-contexts.ts`, `preview-host.ts`, `preview-gate.ts`, `preview-support.ts`; scoped URL capabilities, opaque sandbox, capability gate, closed network policy |
| Preview client | `web/src/components/ArtifactPreview.tsx`, `web/src/preview*.ts`; bridge, runtime, utility, rendered selectors/text, native navigation, scoped parent-owned device capture |
| Markdown reading cache | `web/src/markdown-cache.ts`, `passive-markdown.ts`, `components/PassiveMarkdown.tsx`; bounded immutable bytes, invalidation, and passive reading during preview checks |
| Workspace | `web/src/artifact-page.tsx` is the UI-only page; `artifact-ui-context.tsx` injects reads/actions; `application-ui.tsx` and `pages/ArtifactView.tsx` connect it to the app; `ArtifactHome.tsx`; `artifact-version.ts`, `artifact-navigation.ts`, `artifact-hooks.ts`, `artifact-drafts.ts`, `useArtifactCodeJump.ts`, `useSyntaxPalette.ts` |
| Conversation UI | `ArtifactHeader`, `ArtifactThreads`, `ArtifactThreadCard` (inside `ArtifactThreads`), `ArtifactComposer`, `artifact-discussions.ts`, `useArtifactHandoff.ts`; stable message props, Active/Resolved queues, independently subscribed drafts, shared navbar/panel handoff |
| Source and diff UI | `ArtifactFile`, `SourceCode`, `DiffView`, `FileCard`, `FileBrowser`, `JumpToFile`, `PaneToolbar`; complete foldable stacks, captured rows, virtualization, progressive hydration, retained context |
| Shared presentation | `virtual.tsx`, `progressive.tsx`, `expand.ts`, `useScrollSpy.ts`, `selection.ts`, `gutter.ts`, `keys.ts`, `markdown.ts`, `viewed.ts`, `pane.ts` |
| Highlighting | `server/highlight.ts`, `highlight-worker.ts`, `mermaid.ts`, `patch-hunks.ts`, `compress.ts`; server-owned escaped source HTML and safe Markdown |
| Mobile | `web/src/mobile/` containers only; `ArtifactPage` is their single composition point |
| Static demo | `web/demo/artifact-model.ts`, `artifact-backend.ts`, `artifact-api.ts`, `application-api.ts`, `artifact-fixtures.gen.ts`; same public contract, local scripted workflow |
| Distribution | `scripts/compile.ts`, `spa-css.ts`, `release-binaries.ts`, `stage-npm-packages.ts`, `wait-for-npm-packages.sh`, `gen-artifact-demo.ts`, `build-demo.ts`, `stage-pages.ts`; `npm/` binary launcher |

## Domain rules

An **Artifact** has fixed kind `files`, `html`, or `diff`, optional project,
metadata, creator attribution, and state `active|archived`. Its **Versions** are
immutable complete publications. No Bundle entity, live source, approval state,
individual version removal, or derived files diff belongs to the new model.
Artifacts have no overview field. Optional summaries belong to published versions;
retired overview text and original targets remain historical evidence only.

- `files`: a nonempty complete directory, no index requirement or inference.
  Markdown opens rendered; other text opens as source. HTML/Markdown can switch
  between source and rendered; media has a native
  preview and binary files can be downloaded.
- `html`: the same directory storage with a required root `index.html`.
  Markdown can be companion content; historical versions retain their selected
  entrypoint, including `index.md`. The workspace is rendered, with no file
  browser, source toggle, or companion-file viewer.
- `diff`: an independent immutable sparse patch, retaining old/new sides, binary
  and rename metadata, and captured context. Never apply versions together or
  reconstruct a full tree. Context beyond capture is unavailable.

Publication validates complete binary-safe content, prepares immutable blobs and
retained Markdown HTML, then commits all membership atomically. Markdown carries a
renderer revision; old renderings never change after an upgrade. `publicationKey`
replays the same request, and `expectedSeq` compares the **latest published**
sequence. `nextSeq` allocates above all prior or reserved identities, including
migration gaps. Concurrent publication or archive returns an ordered result or a
conflict. Blob cleanup coordinates with in-progress publication and whole-artifact
deletion; no partial version becomes readable.

**Discussion** has an immutable native target, an author, and human-controlled
`open|resolved` status. New targets distinguish artifact/general,
source line/quote, rendered DOM/text/context/route/viewport, media instant/region/saved frame, and diff
old/new line/quote. Whole-file targets are explicit. The server validates recorded
content and version membership. Rendered evidence is never reverse-mapped into
source lines. Unknown legacy evidence remains explicitly unknown.

The selected version's summary is read-only description in the navigation info
popup. Retired description targets remain readable; new discussions and comment fix
targets cannot anchor to descriptions.

**Placements** are historical read-only records keyed by discussions, version, path, and
representation, with `anchored|ambiguous|unplaced` state. They never rewrite the
original target. Locate initially returns to that original view. An unavailable
runtime element does not make its conversation disappear.

**Comments** are pure messages. Inline references derive from their own fix target
when present, otherwise from the discussion's original target. General discussions
stay unbound without a version target; historical references remain pinned. No comment action resolves discussions. Successful agent comments release
only that same agent's claim.

**Claims** are 60-minute renewable discussions-scoped leases. Another live owner
conflicts. Resolve, archive, deletion, and expiry clear claims. Claim presence is
separate from status, activity ordering, and owner delivery.

**Owner handoff** retains the existing distinction between unsent human content and
agent messages born delivered. Pending reads return a snapshot without acknowledgment.
The CLI writes it successfully to stdout before calling the explicit discussions
acknowledgment endpoint with its required fingerprint. Persisted revisions prevent
stale snapshots from acknowledging edits, including edit-and-revert cycles. Failed
reads/output leave content pending; retries after acknowledgment failure may repeat
output. The web UI copies a `r3 comment fetch` command without acknowledging it.
Successful fetch registers the caller as listener when its harness supports it.
A wake notification alone does not stamp delivery.
Discussion retains whether it was ever delivered independently of the current text's
pending timestamp, so editing cannot suppress a later resolution notification.

**Lifecycle events** have immutable ordered identities, actor, optional artifact-level Comment,
and operation key. Blank archive comments normalize to null. Archive changes state,
records history, clears claims, captures the selected recipient, and removes
registrations before post-commit notifications. Push only a nonblank Comment to
that captured recipient.
A failed push preserves the event and Comment and reports failure; retry does not notify again.
Archive Comments use the common Comment read/edit API and become editable after restore.
A full acknowledged archive notification stamps only its original Comment revision;
late delivery cannot consume a newer edit. Other pending Comments use snapshot handoff.
Restore permits work but never revives an old registration. Archive preserves
discussions state, unsent content, and drafts. Archived content is read-only until
restore: the backend rejects content mutations at commit, including late comments.
The browser retains drafts while disabling mutation controls.

An artifact can retain a publisher fallback and an explicit subscription, with
one selected subscription. A publication replaces the fallback; unsupported publishers
and `--no-listen` clear it. Explicit listen/watch takes priority. Worker delivery
failure retains the selected subscription and reports an error without resending
that attempt. Archive ends subscriptions atomically. A persistent local worker
uses the same protocol for local and remote backends. Disconnect retains backend
subscriptions and marks them unavailable; reconnect binds the same worker and
credential principal to those records without changing selection. Fresh listen
can replace a subscription; ended identities never return. The worker saves local
destinations, not recovery intents. Generic watch remains scoped to its request.
`--session` is a display name; harness identity or `R3_AGENT_SESSION` identifies
authored runs. Generic watch needs no supplied identity. Watch gives archive
priority over pending discussions and timeout, including a watch begun after archive.
Exit codes: archived `0`, pending `10`, timeout `2`, occupied/superseded or snapshot conflict `4`.
Explicit listen adapter unavailability is `5`; automatic setup failure only warns
after successful publication or comment fetch. Generic agents can watch or poll.
Use `cli/artifact-help.ts` as the exact command/help/agent-guide text.

## Browser design

Structural containers use square corners, compact spacing, shared dividers, and no
elevation in the base layer. This includes discussions cards and multiline editors.
Detached outer overlays use rounded corners, visible borders, subtle edge lighting,
and layered shadows; inner content stays flat. Mobile bottom sheets intentionally
keep rounded top corners and square bottom corners. Buttons, filter bubbles, badges,
and ordinary single-line controls retain their existing shapes. Use local CSS;
Ambient CSS is a visual reference, not a dependency.

The selected version stays pinned when a new publication arrives. Announce it and
offer **Go to the latest version**. Drafts hold their native target/context independently of the
current pane, survive view switches, and persist after a 400 ms debounce. Legacy
browser drafts remain evidence rather than being guessed into new targets.

The desktop navbar toggles the discussions dock, restoring its last expanded or floating
mode. Both visible modes also provide an in-panel Hide control. Hidden panels stay
mounted without reserving content space. An anchor gesture with an empty composer
starts a note; a composer holding text gets a quote action instead. A hidden dock uses
the same floating composer. Mobile reuses the conversation state in its sheet.

Keep typing local: memoized thread cards receive stable props, composer text has
its own subscription, native field sizing avoids per-keystroke forced layout, and
the floating composer has its own compositing layer. Paint containment belongs on
already-clipped desktop panes and inactive measured shells; size containment must
not discard scroll height. The mobile sticky toolbar must not be clipped by a
paint-containing ancestor.

Source/diff virtualization keeps a stable 48-row mounted window; progressive diff
hydration reserves measured shells in one scroll pane. Explicit Locate first
unfolds/hydrates, then retries the row jump under a nonce so newer jumps invalidate
older work. The scroll spy measures visible blocks and rechecks on resize.

Source highlighting ships escaped palette classes and one theme stylesheet, never
Shiki/WASM in the browser. Retained document HTML belongs in preview. Discussion,
comments, and summaries render safe client Markdown (`html:false`); inline file refs
resolve against saved, derived reference context. Mermaid's supported diagrams use safe
SVG; unsupported syntax falls through to source.

Opened Markdown is cached by immutable rendering identity in the trusted app's
IndexedDB (64 MiB, 30 days unused, least-recently-opened eviction). Normal app
authentication precedes a passive cached reading view; preview admission requires
verification or remembered compatibility consent before resources or interaction. The passive iframe strips
active elements and URLs and permits only its trusted layout/scroll helper.
Authored HTML requires the blocking gate or remembered compatibility consent.
Cache deletion/logout cleanup must prevent late writes across tabs; logout also suspends caching until normal
authenticated bootstrap. No permanent content capability is added.

Keyboard bindings have a visible control, stand down in text fields and overlays,
and do not repeat mutations. Widget-local keys stay with the widget. Collapsing
the dock or closing the mobile sheet removes its invisible actions from the map.

## Deep reference

Read the relevant `.claude/skills/<name>/SKILL.md` before changing its area:

| Skill | Owns |
| --- | --- |
| [api-surface](.claude/skills/api-surface/SKILL.md) | Routes, command surface, agent loop, delivery and exit codes |
| [security-model](.claude/skills/security-model/SKILL.md) | Origin/Host/auth boundaries, preview isolation, remote configuration, input guards, dependency cooldown |
| [mobile-tier](.claude/skills/mobile-tier/SKILL.md) | Phone containers, sticky mechanics, touch anchoring and ergonomics |
| [build-and-distribution](.claude/skills/build-and-distribution/SKILL.md) | Binary/CSS pipeline, demo/Pages, npm/GitHub distribution and Nix |

Cutting a release is a separate task using the release skill; implementation does
not imply a version bump, tag, publication, or push.

Keep public website content, styles, build scripts, tests, and demo customizations
under `site/`. Its repository integration contract belongs to the
[build-and-distribution skill](.claude/skills/build-and-distribution/SKILL.md#public-website-integration).

## Development and checks

```sh
bun install
process-compose up           # isolated workspace data, application 8891
bun run dev                 # source server, server watch; restart for frontend edits
bun cli/index.ts <command>
bun run build               # self-contained ./r3
bun run gen:demo
bun run build:demo
```

Nix/direnv provides Bun and Biome. Do not read `.env`, `.envrc`, or `.env.*` files.
The source server bundles its guarded SPA assets once at startup. The compiled
binary embeds all application assets and works without a source checkout.

Before committing, run `bun run typecheck`, `bun test`, and `biome check .`.
Use `biome check --write <paths>` for formatting. Tests should prove important
state, timing, byte, migration, or security rules; no coverage target or tests that
merely mirror implementation. Use the component showcases and isolated
browser acceptance scripts to review UI changes.

Tests inject temporary storage or use isolated XDG directories for subprocesses.
Never open, migrate, restart, or modify the normal user server/database just to
verify a change. Browser acceptance uses fresh profiles and controlled endpoints;
device tests use fake devices and actual browser permission denial/grant.

## Committing and house rules

- Work on `main` directly. Use small self-contained commits with a Conventional
  Commit subsystem scope, imperative subject at most 72 characters, no final period.
- Stage only your own files by explicit path. Commit after checks pass. Explain
  motivation in a wrapped body when useful. Leave `git push` to the user.
- Preserve existing authorship metadata; do not attribute work to an unrelated
  agent or add personal/machine identifiers, credentials, or home-directory paths
  to source, fixtures, docs, logs, scripts, or commit messages.
- Keep the server authoritative and storage injected. Do not add a second SQLite
  writer, ambient repository context, live-content read, or edit-version path.
- Keep source, rendered, and diff targets native and immutable; place separately.
- Never weaken auth, origin guards, or the opaque preview sandbox. The preview
  network is closed by default. A failed network capability check permits a new
  restrictive compatibility context only after browser risk acknowledgment.
  Remembered acknowledgment skips future capability gates until forgotten;
  compatible previews retain restrictive headers and the opaque sandbox.
  Broader external access remains an explicit HTML-only grant. Context setup and
  actual origin validation remain mandatory; failures never create consent. Never
  bind all interfaces or move a data endpoint outside its guard. Device consent does not permit external networking.
- Mobile containers must not complicate desktop components; use the mobile skill.
- Keep `HELP` and `GUIDE` in `cli/artifact-help.ts` accurate in the same change as
  any public command, output, flag, or agent-loop behavior.
- Maintain the three-week dependency cooldown; never lower it to install a package.
