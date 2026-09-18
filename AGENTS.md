# r3 — Review. Revise. Resolve.

r3 is a local-first workspace for **published artifacts and human/agent
conversations**. A per-user daemon owns immutable content and persisted feedback;
the browser, CLI, and agents use the same HTTP/JSON contract. The daemon, CLI, and
SPA ship as one self-contained binary. Read [README.md](README.md) for usage.

This file, the [artifact design](docs/artifacts/design.md),
[schema explanation](docs/artifacts/schema.md), and the deep-reference skills below
are the design source of truth. Update the document that owns a decision when it
changes. [Verification](docs/artifacts/verification.md) maps behavior to executable
acceptance checks. Earlier live-file reviews have been retired; historical storage
rows are confined to migration and do not define new API behavior.

## Architecture

The HTTP/JSON contract is the product. Start at `shared/artifacts.ts` (re-exported
by `shared/types.ts`), then `server/artifact-api.ts`, `cli/artifact-commands.ts`,
and `web/src/artifact-api.ts`. Keep all three clients aligned.

```text
publisher: capture local files/git → CLI HTTP upload ─┐
browser: fetch + authenticated event stream ──────────┼→ artifact daemon
agent: CLI/HTTP publications, feedback, claims ───────┘    SQLite + immutable blobs
publisher-side listener ← outward stream ← daemon
opaque preview document → scoped version bytes + trusted r3 runtime
```

- The daemon is the only SQLite writer. Storage and domain services are explicitly
  constructed and injected; importing modules must not open a database.
- Ordinary requests use artifact/version identity. The server never resolves a
  publisher path, Git repository, worktree, or live file. Git and directory capture
  run on the publisher; the one-time legacy migration is the only local-read adapter
  the daemon uses.
- Projects are optional groups, assigned explicitly or inferred from a sanitized
  publisher-supplied Git remote under server policy. Their IDs do not derive from
  paths or URLs. Later publications preserve the group; deletion preserves artifacts.
- One logical agent session identifies one run. Multiple agents, including
  subagents, use distinct IDs. Sessions are attribution, not credentials, accounts,
  artifact ownership, or live presence.
- A local daemon starts lazily and announces itself in
  `$XDG_RUNTIME_DIR/r3/daemon.json`. `R3_URL` chooses an explicit remote server;
  that URL never inherits a local token unless the complete normalized URL matches.
- The loopback application listener dispatches scoped preview paths separately
  from its authenticated API. Previews use the browser's r3 address automatically;
  an explicit endpoint override adds a separate loopback preview listener. Every
  rendered document has an opaque browser origin and no application credentials.
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
| Store and upgrade | `server/artifact-storage.ts`, `artifact-schema.ts`, `blobs.ts`, `migration*.ts`; private backup, atomic migration, recovery, coordinated garbage collection |
| Publication | `server/artifacts.ts`, `publication.ts`, `artifact-validation.ts`; stable upload identity, preparation before atomic publish, immutable membership |
| Project grouping | `server/artifact-projects.ts`, `shared/git-remote.ts`; remote identities, explicit overrides, configured aliases, conditional metadata updates; terms in [CONTEXT.md](CONTEXT.md) |
| Publisher capture | `cli/capture.ts`, `capture-git.ts`, `publisher-remote.ts`, `artifact-publish.ts`; bounded stable bytes, sanitized remote hints, Git process isolation, explicit retry diagnostics |
| Content and rendering | `server/artifact-source.ts`, `artifact-resources.ts`, `artifact-document.ts`, `patch-content.ts`; `git.ts` is a pure patch parser/trimmer |
| Native targeting | `server/artifact-targets.ts`, `artifact-conversations.ts`; original targets and per-version/view placements |
| Collaboration | `server/artifact-lifecycle.ts`, `artifact-collaboration.ts`, `agent-connections.ts`, `artifact-events.ts`; events, handoff, claims, designated recipient |
| HTTP and auth | `server/artifact-api.ts`, `artifact-conversation-api.ts`, `artifact-http.ts`, `artifact-auth.ts`, `auth.ts` |
| Local wake delivery | `cli/artifact-listener.ts`, `cli/listener.ts`; local adapters currently in `server/listener.ts` and `server/inbox.ts` are imported only by the publisher |
| Preview server | `server/preview-contexts.ts`, `preview-host.ts`, `preview-gate.ts`, `preview-support.ts`; scoped URL capabilities, opaque sandbox, capability gate, closed network policy |
| Preview client | `web/src/components/ArtifactPreview.tsx`, `web/src/preview*.ts`; bridge, runtime, utility, rendered selectors/text, native navigation, scoped parent-owned device capture |
| Markdown reading cache | `web/src/markdown-cache.ts`, `passive-markdown.ts`, `components/PassiveMarkdown.tsx`; bounded immutable bytes, invalidation, and passive reading during preview checks |
| Workspace | `web/src/pages/ArtifactView.tsx`, `ArtifactHome.tsx`; `artifact-version.ts`, `artifact-navigation.ts`, `artifact-hooks.ts`, `artifact-drafts.ts`, `useArtifactCodeJump.ts`, `useSyntaxPalette.ts` |
| Conversation UI | `ArtifactHeader`, `ArtifactThreads`, `ArtifactThreadCard` (inside `ArtifactThreads`), `ArtifactComposer`, `artifact-feedback.ts`; stable message props, Active/Resolved queues, independently subscribed drafts |
| Source and diff UI | `ArtifactFile`, `SourceCode`, `DiffView`, `FileCard`, `FileBrowser`, `JumpToFile`, `PaneToolbar`; complete foldable stacks, captured rows, virtualization, progressive hydration, retained context |
| Shared presentation | `virtual.tsx`, `progressive.tsx`, `expand.ts`, `useScrollSpy.ts`, `selection.ts`, `gutter.ts`, `keys.ts`, `markdown.ts`, `viewed.ts`, `pane.ts` |
| Highlighting | `server/highlight.ts`, `highlight-worker.ts`, `mermaid.ts`, `patch-hunks.ts`, `compress.ts`; server-owned escaped source HTML and safe Markdown |
| Mobile | `web/src/mobile/` containers only; `ArtifactView` is their single composition point |
| Static demo | `web/demo/artifact-model.ts`, `artifact-backend.ts`, `artifact-api.ts`, `application-api.ts`, `artifact-fixtures.gen.ts`; same public contract, local scripted workflow |
| Distribution | `scripts/compile.ts`, `spa-css.ts`, `release-binaries.ts`, `stage-npm-packages.ts`, `gen-artifact-demo.ts`, `build-demo.ts`, `stage-pages.ts`; `npm/` binary launcher |

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
- `html`: the same directory storage with exactly one root `index.html` or
  `index.md`, selected automatically. New publications reject both or neither;
  historical versions retain their selected entrypoint. The workspace is rendered, with no file
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

**Feedback** has an immutable native target, an author, and human-controlled
`open|resolved` status. New targets distinguish artifact/general,
source line/quote, rendered DOM/text/context/route/viewport, and diff
old/new line/quote. Whole-file targets are explicit. The server validates recorded
content and version membership. Rendered evidence is never reverse-mapped into
source lines. Unknown legacy evidence remains explicitly unknown.

The selected version's summary is read-only description in the navigation info
popup. Retired description targets remain readable; new feedback and reply fix
targets cannot anchor to descriptions.

**Placements** are separate records keyed by feedback, version, path, and
representation, with `anchored|ambiguous|unplaced` state. They never rewrite the
original target. Locate initially returns to that original view. An unavailable
runtime element does not make its conversation disappear.

**Replies** are pure messages. Their explicit version/representation context pins
inline references; an optional fix target is independent and may name a different
version/view. No reply action resolves feedback. Successful agent replies release
only that same agent's claim.

**Claims** are 60-minute renewable feedback-scoped leases. Another live owner
conflicts. Resolve, archive, deletion, and expiry clear claims. Claim presence is
separate from status, activity ordering, and owner delivery.

**Owner handoff** retains the existing distinction between unsent human content and
agent messages born delivered. Reading a prompt is not acknowledgment. A draining
POST acknowledges its exact snapshot; manual copy first succeeds at clipboard
write and then sends the snapshot fingerprint. A newer edit conflicts instead of
being silently marked read. A wake notification alone does not stamp delivery.

**Lifecycle events** have immutable ordered identities, actor, optional message,
and operation key. Blank messages normalize to null. Archive changes state,
records history, clears claims, and captures/removes the current listener before
post-commit notifications. Push only a nonblank message to that captured listener.
A failed push preserves the event and reports failure; retry does not notify again.
Restore permits work but never revives an old registration. Archive preserves
feedback state, unsent content, and drafts; in-flight replies remain accepted.

One designated listen/watch recipient exists per artifact. Watch gives archive
priority over pending feedback and timeout, including a watch begun after archive.
Exit codes: archived `0`, pending `10`, timeout `2`, occupied/superseded `4`.
Automatic local adapter unavailability is `5`; generic agents can watch or poll.
Use `cli/artifact-help.ts` as the exact command/help/agent-guide text.

## Browser design

Structural containers use square corners, compact spacing, shared dividers, and no
elevation in the base layer. This includes feedback cards and multiline editors.
Detached outer overlays use rounded corners, visible borders, subtle edge lighting,
and layered shadows; inner content stays flat. Mobile bottom sheets intentionally
keep rounded top corners and square bottom corners. Buttons, filter bubbles, badges,
and ordinary single-line controls retain their existing shapes. Use local CSS;
Ambient CSS is a visual reference, not a dependency.

The selected version stays pinned when a new publication arrives. Announce it and
offer **Go to the latest version**. Drafts hold their native target/context independently of the
current pane, survive view switches, and persist after a 400 ms debounce. Legacy
browser drafts remain evidence rather than being guessed into new targets.

The desktop navbar toggles the feedback dock, restoring its last expanded or floating
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
Shiki/WASM in the browser. Retained document HTML belongs in preview. Feedback,
replies, and summaries render safe client Markdown (`html:false`); inline file refs
resolve against explicit message context. Mermaid's supported diagrams use safe
SVG; unsupported syntax falls through to source.

Opened Markdown is cached by immutable rendering identity in the trusted app's
IndexedDB (64 MiB, 30 days unused, least-recently-opened eviction). Normal app
authentication precedes a passive cached reading view; preview checks continue
before enabling resources, navigation, or feedback. The passive iframe strips
active elements and URLs and permits only its trusted layout/scroll helper.
Authored HTML retains its existing blocking gate. Cache deletion/logout cleanup
must prevent late writes across tabs; logout also suspends caching until normal
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

## Development and checks

```sh
bun install
process-compose up           # isolated workspace data, application 8891
bun run dev                 # source daemon, server watch; restart for frontend edits
bun cli/index.ts <command>
bun run storybook            # component workshop on 6007
bun run build               # self-contained ./r3
bun run gen:demo
bun run build:demo
```

Nix/direnv provides Bun and Biome. Do not read `.env`, `.envrc`, or `.env.*` files.
The source daemon bundles its guarded SPA assets once at startup. Vite is used
only by Storybook. The compiled binary embeds all application assets and works
without a source checkout.

Before committing, run `bun run typecheck`, `bun test`, and `biome check .`.
Use `biome check --write <paths>` for formatting. Tests should prove important
state, timing, byte, migration, or security rules; no coverage target or tests that
merely mirror implementation. Components have Storybook stories as their visual
surface. Update a story when changing a component.

Tests inject temporary storage or use isolated XDG directories for subprocesses.
Never open, migrate, restart, or modify the normal user daemon/database just to
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
  Broader external access remains an explicit HTML-only grant. Isolation and
  transport failures always stay closed. Never bind all interfaces or move a data
  endpoint outside its guard. Device consent does not permit external networking.
- Mobile containers must not complicate desktop components; use the mobile skill.
- Keep `HELP` and `GUIDE` in `cli/artifact-help.ts` accurate in the same change as
  any public command, output, flag, or agent-loop behavior.
- Maintain the three-week dependency cooldown; never lower it to install a package.
