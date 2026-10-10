# Artifact design

r3's implemented model is **Artifact → Version → Content**, with threads and
comments grouped into its **Discussion**. A Thread is one resolvable topic; a
Comment is one message. Archive comments belong directly to the discussion.
Reviewing is an activity on that work product.
This document explains the product boundaries and the reasons behind them.

Use [the domain glossary](../../CONTEXT.md) for canonical terms,
[the schema reference](schema.md) for storage constraints and migration,
[verification](verification.md) for acceptance checks, and the
[API reference](../../.claude/skills/api-surface/SKILL.md) for routes and commands.
The public wire types live in [shared/artifacts.ts](../../shared/artifacts.ts).

## Reusable workspace UI

`web/src/artifact-page.tsx` exports `ArtifactPage`, the same workspace used by the
connected application and the public website. Its host supplies an immutable
`ArtifactDetail`, typed `data` reads, typed `actions` mutations, and a
`renderPreview` renderer. On changes, the host supplies a new detail snapshot;
returned mutation values and query invalidations retain the existing optimistic
UI behavior. Optional chrome slots supply application navigation and settings.
An optional query client lets the connected app share its cache.

The page owns interaction, layout, versions, threads, comparison, and the
single mobile composition point. It imports no HTTP client, authentication,
router, backend selection, or preview-session setup. `application-ui.tsx` and
`pages/ArtifactView.tsx` own those connected concerns. Presentation components
read the supplied client from a required context; there is no live API fallback.

Hosts load `web/src/main.css` through the existing Tailwind build and mount one
page per document: keyboard bindings, display preferences, and draft state are
currently document-wide. Website embeds use a separate document to isolate these
and the app stylesheet. The site's renderer is an authored React example, not a
way to execute arbitrary published content. Production continues to supply its
opaque preview renderer and enforce its existing security gate.

## Three kinds, one publication model

| Kind | Published content | Workspace |
| --- | --- | --- |
| `files` | A complete directory with at least one file | All files in one scrolling pane with foldable headers and a synchronized file browser; Markdown opens rendered, other text opens as source, with per-file HTML/Markdown view switching, media previews, and downloads |
| `html` | A complete directory with a root `index.html` | Rendered entrypoint and discussion panel; no file browser or source toggle |
| `diff` | An independent unified patch | Captured old/new lines, split or unified layout, and expandable retained context |

Kind stays fixed for an artifact. CLI creation requires an explicit `--kind`;
capture flags and index files never infer it. A new HTML version requires exactly
a root `index.html`, selected automatically; entrypoint overrides are rejected.
An accompanying `index.md` is ordinary content. Historical versions retain their
selected entrypoints, including Markdown, and complete membership unchanged.
Individual zero-byte files are valid; empty directory publications are rejected.

Files and HTML share file storage, retained rendering, and resource serving. HTML
specializes the workspace: the entrypoint and its linked pages determine how the
reader encounters supporting files. The CLI/API can still retrieve those files.
Neither directory kind offers a diff view.

The desktop file panel resizes from its right divider, remembers its width across
folding and navigation, and resets on double-click. The focused divider also accepts
arrow keys to resize and Home to reset.
For files artifacts with one file, the panel starts collapsed; Show files opens it.
This automatic default does not change the saved panel preference for other artifacts.

Files artifacts use the file panel's tree order throughout the content stack and
file navigation: visit folders before files at each level, sorting siblings
alphabetically. Folding a folder in the panel does not reorder or hide its content.

Every file in a files artifact has a download action immediately after its header
path, including media, text, HTML, and binary content. Hovering that path area or
focusing its controls reveals the action; touch devices keep it visible. It works
while folded and saves the selected version's original bytes under the filename,
without changing Viewed state. Pending downloads disable the action, and failures
appear outside the folded body so the reader can retry.

File and diff headers copy paths by segment: clicking the filename copies only
that name, while clicking a directory copies that segment through the filename.
Hover or keyboard focus underlines the exact suffix. A successful copy colors it
green and shows a green copy icon and check for one second; another successful
copy restarts that confirmation. A failed copy never shows success. These path
controls do not change folding, Viewed state, or the selected file.

A diff keeps its sparse patch payload. Removed lines, hunk gaps, rename metadata,
and binary markers cannot be represented by a fabricated complete directory.
Publication order does not imply patch application: version 2 need not apply on
top of version 1. Diff rendering produces HTML for display while retaining native
old/new target semantics.

Patch text must be valid UTF-8; capture rejects malformed bytes rather than
replacing them. Files artifacts can retain non-UTF-8 content as original bytes.
Git capture uses stable path prefixes and the short submodule format, including
changed submodule pointers regardless of display or ignore preferences. It does
not recursively capture submodule contents. Git binary patches remain supported.

All kinds share version identity, conversations, claims, owner handoff, and
active/archived lifecycle. Files and HTML own their members directly; there is no
additional directory-container entity for a caller to create or manage.

Artifacts have a title and metadata, with no overview field or overview panel.
Optional summaries belong to immutable versions and appear as the selected version's
description in the navigation's details popup. Descriptions have no body section or
comment anchors. New threads target artifacts or documents; comment fix targets
identify documents. Retired overview and version-description targets remain readable
historical evidence.
Locate on an existing description thread opens that version's details popup. Saved
description drafts retain their text and quote until the user clears or replaces the target.

Opening an artifact uses a centered loading spinner in the application's current
light/dark theme, with a static indicator when reduced motion is requested. A
rendered preview stays covered and unfocusable through verification until its
document is ready. Setup frames never add browser history entries; native links
within a mounted document and page navigation in HTML artifacts keep their
ordinary Back/Forward behavior. Cross-file links in files artifacts scroll within
the file stack instead of adding a history entry.

## Publication and content ownership

The publisher captures local input and sends complete bytes. The server owns the
published content; ordinary reads never resolve a checkout, worktree, or publisher
path. Projects are optional groups selected explicitly or inferred from a sanitized
publisher-supplied Git remote. Their opaque IDs remain independent of filesystem
location and remote URL. A publisher can go offline or delete its directory without making
stored versions unreadable.

`projectGrouping` defaults to `remote`; `manual` disables inference. Explicit
`projectId` (including null for ungrouped) wins over configured `projectMappings`
and the stored remote identity. HTTPS and SSH/scp forms share a repository key;
path case and non-default ports remain significant. The server never fetches a
remote. Creation resolves/reuses its project transactionally; later publications
preserve the artifact's assignment. Mappings point to ordinary existing project IDs.

`PATCH /api/projects/:id` updates a name or primary remote, with optional
`expectedRemoteUrl` for compare-and-set backfill. Changing the primary remote
replaces its automatic mapping; configured aliases are separate. A remote already
owned by another project conflicts. Removing a project preserves its artifacts
and deletes its automatic mapping; remove any configured aliases separately.

Publication has two distinct consistency boundaries:

1. Publisher capture checks stable file membership and bytes, or captures immutable
   Git objects and verifies mutable inputs. A changing source fails capture.
2. The server validates kind, paths, membership, sizes, and patch syntax, prepares
   immutable blobs and retained Markdown HTML, then commits the complete version
   in one transaction before broadcasting its availability.

`expectedSeq` compares the latest published sequence, and `publicationKey` identifies
an identical retry. Sequence allocation also respects historical gaps reserved by
migration. A conflict requires inspecting current history before publishing again.
An interrupted upload never exposes a partial version or changes an earlier one.
See [atomic publication](schema.md#atomic-publication) for the transaction rules.

Each directory version carries complete membership. Omitting a path removes it
from that version while earlier versions retain it. Original bytes and retained
Markdown HTML share content-addressed storage. The rendering revision is retained
with the HTML, so a renderer upgrade cannot move an old rendered annotation by
silently regenerating its document.

Every published version remains visible until whole-artifact deletion. Corrections
are new publications. Whole-artifact deletion removes its history and conversations;
shared bytes are collected only when no publication references them.

The artifact list shows total content storage. The three-dot menu also shows the
latest publication's full size, regardless of the selected version. Sizes use
decimal units (1 KB = 1,000 bytes); hovering a value gives the exact byte count.
Totals count shared content once within the artifact and exclude database overhead;
see [storage accounting](schema.md#content-storage-accounting) for the precise scope.

## Resources and page authoring

The application API separates membership from original bytes:

```text
GET      /api/artifacts/:id/versions/:seq/files
GET/HEAD /api/artifacts/:id/versions/:seq/resource?path=<encoded-relative-path>
```

The first returns the file list as JSON. The second returns original bytes with
media type, validators, private caching, and byte-range support. Application-origin
downloads are attachments. Executable content belongs to the sandboxed preview dispatcher.

A preview context binds one artifact/version to a temporary random URL prefix on
the browser's application address. Its `files/<path>` resources use that version's
content; `r3/` serves trusted preview support. Documents use `sandbox="allow-scripts"`
and the same CSP sandbox, producing a fresh opaque origin on every navigation.
Native modules, CSS, images, audio/video, fetch, and XHR use scoped URLs and
credential-free resource CORS. No preview cookie or application credential is
needed. Gate HTML has no CORS headers. Unknown paths return 404, with no
other-version, filesystem, or proxy fallback.
The capability authorizes bytes without a server challenge or browser registration.
The trusted workspace runs the browser gate and handles risk consent before loading
publisher content. Response sandboxing, restricted frame ancestors, and rejection
of top-level document navigation apply independently of this client gate.

Author pages with relative URLs, hash routes, and published document paths:

```html
<img src="./images/plot.png">
<video controls src="./media/demo.webm"></video>
<script type="module">
  const data = await fetch('./data/chart.json').then(response => response.json());
</script>
```

Those requests stay on the displayed version after a newer publication arrives.
Links to published documents use normal directory-relative resolution. The utility exposes a
`resourceRoot` for constructing URLs from the version root. A leading `/` addresses
the preview origin root, not that resource root; arbitrary root-relative rewriting
and SPA history-route fallback are unsupported. A missing asset remains distinct
from a client-side route.

In files artifacts, an ordinary link to another captured HTML or Markdown
document opens its rendered file card, unfolds and hydrates it if needed, and
scrolls to the requested heading. A link without a fragment opens the file's
beginning. The destination receives the link's query and fragment; the source
card keeps its own document. Same-file anchors and HTML artifact page navigation
retain their native behavior.

## Reading, selecting, and locating

The browser pins the displayed version. A new publication is announced with an
**Go to the latest version** action; it does not replace the content being read. Version switches
and representation toggles preserve a draft's original target and message context.
Artifact links can include `version`, `file`, `view`, and `threads` query parameters.

Rendered Markdown follows r3’s selected light/dark appearance, including its syntax
palette. Trusted preview support applies explicit text/background colors and adapts
legacy OS-dependent palette rules in memory; retained document bytes stay immutable.
Authored HTML keeps its own appearance.

Source files and both captured diff sides use every language bundled with Shiki.
Filename detection uses Shiki IDs and aliases, generated grammar file types,
and explicit associations for common missing extensions and special filenames.
Compound suffixes take precedence over shorter extensions. Shared extensions
have fixed defaults (for example `.h` is C, `.m` is Objective-C, `.v` is V,
and `.fs` is F#); detection does not inspect contents or infer dialects. Unknown
names remain escaped plain text. Grammar loading stays on demand in the server,
with the existing size limit, worker timeout, and plain-text failure fallback.

Publication reuses a retained Markdown rendering when source digest, path, and
declared renderer revision match an existing publication. The existing version
membership is the cache index; no second durable rendering store is needed.
Reused blobs are verified under the publication's garbage-collection hold.
An upgraded renderer produces new output only for new publications.

File stacks containing Markdown defer unopened bodies until they enter the viewport
or an explicit file jump needs them, even in small artifacts. Provisional shells
reserve space until document sizing arrives; an already measured shell keeps its
height while a replacement preview loads. Restoring an absolute reading offset
first hydrates preceding files in order, so it may open more than one document.

Folding a rendered Markdown file retains its loaded preview in memory, hidden and
inert, so unfolding reuses the document and measured height without fetching it
again. Initially folded files still load only when opened. Switching to source,
changing versions, or leaving the artifact releases the preview normally. Scrolling
away keeps loaded Markdown mounted and measured.

Opened media previews (images, audio, and video) also stay mounted when scrolled
out of view. Images reuse their loaded document without a scroll-triggered reload;
playback continues and paused position, mute state, volume, and playback speed
survive the scroll. Native video previews start muted; readers can unmute them
using the player controls. Audio previews retain their audible default.
Unopened previews remain lazy. Explicitly folding a media file, changing
versions, or leaving the artifact releases its preview; playback state is not
persisted across those actions. Retention keeps opened previews in memory for the
current workspace visit, including their image and media resources.

Opened Markdown also has a workspace-owned IndexedDB cache, keyed by artifact,
version, path, retained rendering hash, and renderer revision within the application
origin/base. It holds at most 64 MiB, evicts least recently opened documents, and
expires entries after 30 days without use. Oversized documents and unavailable
browser storage fall back to ordinary reads. Cached bytes are hash-checked before
use; injected scripts, capabilities, and permission grants are never cached there.
This includes Markdown companion documents and historical Markdown entrypoints
in HTML artifacts, but not authored HTML.

After ordinary application authentication, a warm Markdown visit first displays
a passive local reading view while preview checks run. It preserves formatting,
theme, and scroll, but strips navigation/resource attributes and active elements.
An opaque iframe's restrictive CSP permits only a trusted layout/scroll helper;
publisher scripts, images, network requests, links, and comment actions are absent.
The normal interactive document replaces it after admission and layout are ready.
There is no additional login check and no display before application bootstrap.
Authenticated application HTML carries bootstrap and the addressed artifact's
detail, so the workspace can start without two serial API round trips. Detail
includes current labels for referenced agent sessions, eliminating the global
session-list request for attribution. For HTML artifacts the shell also carries
the selected version’s immutable file manifest, bounded to 128 files and 64 KiB
of JSON; larger manifests retain their parallel API read. This metadata does not
authorize publisher execution without browser verification or remembered risk
consent. The shell uses private/no-store responses with escaped JSON; static bundles remain cached.
Cross-site entry falls back to same-origin bootstrap. Inline snapshots never
resume suspended caches: those use fresh bootstrap with the existing epoch guards.
Unreadable cache/logout state also requires fresh bootstrap, so unavailable browser
storage cannot admit an older HTML response after logout.
For the selected HTML entrypoint, the same authenticated GET can renew an existing
preview context, keeping its URL while removing the initial renewal round trip.
A bounded application cookie carries non-authorizing lookup hints; only after
authentication does the server match artifact/version/entrypoint/origin and return
renewed restrictive contexts. With no live match it prepares a blocked/compatible
pair. The browser chooses using local consent, checks origin/version/path, and
accepts a retained descriptor only for this tab’s exact saved context ID. It
consumes setup once. First use retires an unused prepared alternative; external
access is never prepared. Unavailable or mismatched setup uses the normal API
path. HEAD requests do not allocate or renew contexts.
SSE ready/reconnect continues to reconcile mutable artifact state in the background.
Cold visits retain the loading indicator. Definitive failures remove the reading
view; cached bytes never bypass authorization for server access.

The current temporary preview capability supplies retained bytes on a cache miss.
A server-served empty Markdown shell retains response security headers and the
native document URL. After preview admission, the trusted parent sends the selected
document over its exact port; Markdown runtime setup waits for the content mount.
New or expired preview contexts can therefore reuse immutable document bytes.
Logout, unauthenticated boot, known deletion, and definitive access failures clear
relevant entries. Reconnecting reconciles cached artifact IDs against one artifact
list without downloading documents. Transactional invalidation prevents pending
downloads in any tab from repopulating deleted entries. Logout and authentication
failure also suspend persistent reads and writes across tabs until a successful
normal bootstrap; an older in-flight bootstrap response cannot lift that suspension.
Preview-context expiry alone does not establish artifact deletion. Offline deletion is learned
on reconnect; this does not provide an offline application or bypass login.

Source responses, rendered documents, and trusted preview scripts use private HTTP caching with mandatory
revalidation. Matching validators skip source highlighting or document rewriting
and blob reads, after membership and access checks. Immutable companion resources
keep long-lived private HTTP caching. The browser controls cache size and eviction.
Only normally requested resources are cached; there is no prefetch or offline reader.
Opening an HTML version's declared entrypoint starts its preview context alongside
the file manifest, with a browser gate when consent is absent. Publisher content requires manifest
membership and either gate success or remembered compatibility consent. The trusted
runtime is embedded in the document response before publisher scripts, removing a blocking request while preserving execution order. Generated
preview HTML and scripts use negotiated gzip; their validators cover the runtime.

Protected document context identities are retained per tab so reopened previews
reuse their URLs during in-app navigation and full reloads. Matching resume hints
fold renewal into application HTML. Missing or evicted hints fall back to API
renewal of the same saved ID; they never force a new URL. A new independent tab
creates its own context rather than sharing another tab’s revocation lifetime.
Contexts still expire and server capacity stays bounded; expired or revoked
contexts require new URLs. Logout clears the optional hint cookie, which carries
neither capabilities nor consent. The gate repeats unless compatibility consent
is remembered. External-access and device grants never persist. Deletion clears app content state
and context identities when detected, but physical HTTP-cache eviction belongs to
the browser. See the security reference for expiry and retention bounds.

Reading positions are bounded, debounced session metadata keyed by artifact,
version, path, and representation. File stacks restore the outer pane; independently
scrolling previews report root coordinates over their existing document-bound bridge.
Explicit Locate and native fragment navigation win, and user input cancels a
pending restoration. HTML application state and nested scrollers are not retained.
Deletion clears these positions when detected.

Workspace containers follow the layer rules in `AGENTS.md`. Menus and notices use
compact elevation; floating conversations/composers and dialogs use broader shadows.
Shared overlay tokens provide strong border contrast and rim lighting in both themes.
Transient delivery, lifecycle, workspace, preview, and capture notices share one
stack at the bottom right of the viewport. A portal keeps the stack outside pane
clipping and hidden discussion containers; each notice disappears when its originating
component unmounts. Notices use a semantic icon, a short title, optional supporting
text, and a visible dismiss control. Successful notices dismiss after five seconds,
paused while hovered or focused; warnings and errors remain until dismissed. On
phones the stack clears the discussion bar and respects safe areas. Capture hides the
stack from captured pixels. Field validation and persistent navigation actions stay
with their controls.
Mobile sheets cast upward and retain their intentional rounded top corners. The
floating composer has one complete neutral outer border and no colored left stripe.

The top navigation contains the artifact's read-only title and rendered comment-mode
selection-cursor icon. Active navbar toggles use colored borders and icons without
a filled background. The `r3` text links to the artifact list, with compact spacing
around the divider separating it from the title. Every artifact kind has a labeled
icon, including a browser window for HTML. Active status has no badge; archived
artifacts show **Archived**. A three-dot button opens the details popover containing
the description, IDs, metadata, lifecycle history, and Archive/Restore action.
Raw artifact metadata and publisher attribution are collapsed under **Details**.
The artifact list uses kind icons, relative update times, and unhandled counts;
only archived state is labeled. Exact timestamps remain available on hover.
Title editing lives in an explicit **Edit title** form inside that menu.
A **Settings** row closes the artifact menu and opens the settings popup; dismissing
it restores focus to the three-dot trigger. The artifact navbar has no separate gear.
There is no separate body header or delete button. Navbar action buttons
highlight only their outline on hover;
their text, icons, and transparent background stay steady. Desktop actions leave
vertical breathing room, while mobile retains its larger touch targets. The title
and version selector form a group without vertical dividers, before the flexible
space in the top navigation. The selector's trigger shows the version badge and
disclosure caret, with an outlined **latest** badge between them when the latest
version is selected. Expanded choices retain their labels in newest-first order
without redundant latest badges.
Below the `md` breakpoint it moves into the three-dot details
popup, where its choices expand inline. Selecting a version closes that popup.
The picker supports arrow keys, Home/End, and Enter; Escape closes its current
layer without selecting. Menus focus their selected option or first enabled
control and return focus to their trigger on dismissal. Escape closes one layer
at a time, preserving any menu beneath a native permission dialog.
While an older or unavailable version is selected, **Go to the latest version** appears in the
top navigation immediately right of the version selector, with an amber outline. On narrow screens it
shares the version section in the three-dot menu. Opening latest closes that menu,
and the button disappears on the latest version. The desktop
discussion-panel toggle precedes comment mode and the three-dot menu on the right.
HTML artifacts have no empty content toolbar. File-tab headers contain reading and
discussion controls. Narrow headers show source/rendered icons and the Viewed checkbox
with accessible names, preserving space for filenames. Enabled reading controls
remain legible; touch hit areas grow within the compact header rows. Binary and oversized source placeholders offer **Download file**
in the content body.

Rendered Markdown in file artifacts expands to its natural document height within
the file stack. The main content pane owns vertical scrolling; width changes and
late-loading images resize the card in both directions. Only retained Markdown
members and native video previews can report height through the current verified
document port. Videos fill the file card's width at their natural aspect ratio;
the card grows and shrinks with the video so controls remain visible and scrolling
stays in the outer pane. HTML, images, and audio keep their viewport layout,
including Markdown documents viewed within HTML artifacts.
This presentation behavior does not rewrite retained document bytes.
Comment controls stay inside the visible part of a tall frame, clear of sticky
file headers, and follow the outer scroll position. Rendered Locate waits for file
hydration, header alignment, and initial Markdown sizing before jumping to its target.

The discussion dock retains the compact **Active / Resolved** tabs. Its **Add comment**
button shares the bubble-plus icon with whole-file comments. Resolve has
neutral text and no visible outline at rest; hover adds a green border, text, and tint.
The status tabs and their sliding highlight use the same corner radius as buttons.
Active and Resolved are persistent adjacent queues. A 220 ms horizontal slide puts
Resolved to the right of Active; reversing a switch reverses the movement. Each
queue keeps its scroll position and editors. Inactive content is inert and hidden
from accessibility APIs. The new-comment composer belongs to Active and moves
with it; an anchor gesture or Add comment opens Active. Reduced motion
switches immediately. Row insert/delete/reorder animations stay within each queue.
Transient background read failures retain the loaded workspace. Definitive missing
artifact or access errors replace it with an error state.
Resolve and Reopen update the queue immediately while the server saves. Pending
decisions are applied over refreshed server state, so incoming comments remain visible.
A failed save restores that thread and shows its error without rolling back other
decisions. Handoff waits for pending status saves; only the server persists status.
Active threads prioritize freshly posted human notes (unsent, with no comments or
claim), then unhandled threads, then waiting threads, then claimed work. Each
group sorts by creation time, newest first; equal timestamps preserve reverse
server insertion order. This keeps a new card beside its composer until handoff,
while commenting moves a handled card below threads still needing attention. The
existing reorder animation shows that move without automatic scrolling. Unhandled
means an open thread whose latest message is from an agent; a posted human comment or
resolution clears it. Opening the panel does not. The navbar discussion button shows
one primary-color dot only when there are unhandled agent messages. Draft and unsent
counts stay in its tooltip and accessible description without lighting the dot.
The browser tab favicon adds a blue dot for the current artifact's same unhandled
agent threads. Viewing the tab does not clear it; a human comment or resolution does.
Leaving the artifact restores the ordinary icon, including if its badge asset is
still loading.
Unsent human input shows a desktop navbar handoff button immediately before
the discussion toggle, available while the panel is hidden. Both navbar handoff
variants disappear while the dock is expanded or floating, leaving the panel's
control. Hiding the navbar action fades it right toward the discussion toggle and
collapses its space; showing it reverses that transition. Hidden controls are inert,
and reduced-motion preferences disable the transition. With no listener/watcher,
**Use in agent** opens a small command popover, even without pending comments.
It shows `r3 comment fetch <id>` and a copy icon, with instructions to run it using
`!` in the agent harness. Copying leaves comments pending until the CLI runs.
The panel retains the same control, including on mobile. Command popovers support
Escape, outside dismissal, and focus return; their top layer avoids pane clipping.
Both send controls share the in-flight request guard and delivery receipts.
Handoff errors appear in the shared corner stack with guidance to check that the
agent session is running and listening, a copyable fetch command, and expandable
delivery details. Posting adds threads to
r3; **Send to agent · N** notifies the registered recipient. Successful notification
delivery, including Codex queue acceptance, shows **Sent** for three seconds and
the same **Agent notified** notice. This confirms adapter acceptance, never that
the agent read or processed threads. It then hides the navbar action and keeps
the panel button disabled until new human inputs are pending. A browser receipt covers exactly the inputs present when
the ping began; concurrent edits remain eligible. Agent comments, claims, and body
edits do not invalidate that receipt. Receipts synchronize across tabs and retain the latest successful request, so
older completions cannot overwrite newer input and historical values can be sent again. A bounded cache persists hashes; if Web Crypto is unavailable,
exact inputs stay in memory for the current visit. This confirmation never stamps
server threads as read. Failed or absent delivery remains retryable. Disabled handoff
reasons remain in the button tooltip. The draft badge shares the filter row, so
typing does not add a row or shift the composer. General notes open on demand as
the first pending card in the same scrolling list as threads. After the server
confirms a new note, its returned record enters the cache immediately and replaces
the composer at the top. The outgoing composer crossfades into the saved card while
its height eases to fit; Cancel and Discard keep the ordinary removal animation.
Reduced motion skips the transition. Failed saves retain the draft. Event-stream
reads that arrive before the POST response cannot duplicate or overwrite the note.
Agent messages keep their attribution inside tinted bubbles; human messages omit
the redundant author label. General thread has no location heading. Card target
and fix labels omit the version only for the latest publication;
older versions remain explicit. These labels omit representation words, retaining
paths, line ranges, and diff sides. HTML comment fix links instead show the agent's
plain-text `locator.label`, with **Page element** (or **Page** for a whole-page
target) as the legacy fallback. Their tooltip exposes the version and selector;
the published path stays in the target. Stored context and Locate behavior never change.
Comments omit a separate context label; their saved context still pins inline file
references, and explicit fix links remain visible.
Quoted targets offer expansion only when the text exceeds the three-line preview;
the control rechecks clipping when the panel resizes.
Long conversations fold earlier comments. Nonempty drafts block handoff until posted or discarded. Drafts
for deleted threads are removed; resolving or archiving keeps them. Folding the
dock or closing the mobile sheet disables its conversation shortcuts.

Within one browser origin, tabs share one new-comment draft per artifact and one
comment draft per thread. Edits persist after a 400 ms debounce and update other
tabs through storage events. The latest saved edit wins when tabs edit the same
draft; independent drafts use separate storage keys. Clearing a draft also
propagates. Older browser drafts remain readable until replaced or discarded.

The desktop discussion panel has three persisted display states:

- **Hidden:** the content fills the workspace; anchors can open individual threads.
- **Expanded** (default): the original side panel reserves space beside the content.
- **Floating:** the panel initially overlays the right side of the content, below its toolbar.
  Drag its header or grip to move it; drag any edge or corner to resize. Position
  and size persist separately from the docked width. Restored geometry is clamped
  inside the available workspace. The grip and bottom-right handle also accept
  arrow keys (10 px, or 50 px with Shift). Mobile keeps its existing sheet.

Hidden and floating reserve no content space, so switching between them or resizing
the floating panel never changes content or preview width. Expanded reserves the
panel's width and resizes content with it. Visible panels offer **Float discussion** / **Dock discussion** and **Hide discussion**. Hide uses a right chevron when docked and a close icon when floating. The desktop navbar button or `p` hides the panel or
restores the last visible mode. That choice persists across reloads. All states keep
the panel mounted to preserve UI state and drafts. Existing folded preferences become
hidden and reopen expanded if no visible-mode preference was saved.
`Esc` hides either visible desktop mode while preserving drafts. Editors and open
popups handle Escape first. With the panel open, `n` opens Active and focuses general
threads, retaining any populated draft's existing target.
These shortcuts stand down during text entry, modal overlays, and key repeat.
Float/dock changes animate the existing panel shell for 360 ms from its current
visual position and size, including corners and shadow. Content takes its final
width immediately. A rapid reversal starts from the in-progress position.
Floating hide/reveal fades the existing shell for 200 ms in its retained rectangle;
the hidden panel is inert and reserves no space. A floating hide that interrupts a mode
change fades from its current visual position instead of jumping to the dock. Direct drag/resize,
viewport resize, and reduced motion end the transition; saved geometry remains
independent of these temporary visual transforms.
The default discussion width is 38.2% of the workspace (the golden-ratio split),
within the 300–700 px resize limits. Double-clicking the divider clears the saved
width and recalculates this proportion for the current workspace in either visible mode.

With the panel hidden, selecting an existing source/diff anchor or rendered
comment marker opens only that conversation in a floating card. Comment and status
actions reuse the same thread component and draft store. Closing the card keeps
drafts; **Open discussion** restores the full panel in its last visible mode. Changing version or view
closes the card. Mobile continues to use its shared discussion sheet.

Thread cards retain their original motion: a quick fade with a 250 ms rise on
insertion, a 200 ms fade/slide to the right on removal, and a 200 ms move between
positions when reordered. The Active/Resolved fill eases in and out between measured
tab boxes over 380 ms, stretching to 118% width and flattening to 85% height at the
midpoint before settling to the selected tab. Labels stay unscaled; an interrupted
transition reverses from its current position and shape.
Reduced-motion preferences disable these animations.

Rendered comment mode intercepts element picks before page handlers and supports
selecting a parent element. `c` toggles comment mode from the workspace or a focused
document preview. With a node picked, `Space` invokes **Comment here** and opens the
thread editor for that node. Text entry, modifiers, IME, overlays, and held keys
do not trigger these actions. Normal mode preserves page interaction. Source and
diff selections use their own range gestures. Each creates a native target:

| Target | Evidence | Locate behavior |
| --- | --- | --- |
| Source | Published path, version, source range and quote | Open that source view and range |
| Rendered | Published document/version, selector, optional text/context, route and viewport | Open that rendered document and locate its element/text |
| Diff | Patch version, path, old/new side, captured range and quote | Open that patch and native side, hydrating or expanding retained context as needed |

Artifact-wide notes and whole-document/file targets are explicit variants.
Summary targets survive only as historical evidence; new comments cannot use them. Absence of version context never secretly means latest.

A Thread's original target is immutable. Use a Comment's fix target to name a
later published location. Historical **placements** remain readable with their native
evidence and match state, but new placement authoring is retired.

Rendered Markdown thread addresses visible content directly. For example, a note
on a link label does not need a computed Markdown source range. Its thread appears
in both views, and Locate returns to the rendered view where it began. Source notes
work symmetrically. Exact cross-representation matching is not required.

Text selection in source, diffs, rendered Markdown, and HTML works outside comment
mode. Inputs, textareas, selects, and editable regions are excluded. Selection and
gutter gestures open an unfocused composer, preserving
native Copy. Source/diff locators retain the full selected start/end range while
the browser stores a quote excerpt of at most four lines and 2,048 UTF-16 code
units, trimming surrounding whitespace. Native text capture excludes gutters,
diff signs, and blank-row display placeholders. The server verifies that the
complete range exists and that the nonblank quote occurs within its captured
bytes; the quote need not cover every line. Version, file, diff side, contiguous
capture, and target limits remain mandatory. `r3 thread source <thread-id>`
reads the complete original source/diff range on demand without acknowledging
threads. Existing saved quotes remain immutable.
Space or forward Tab focuses the visible new-note composer at the end;
Shift+Tab, editable fields, keyboard-focused controls, IME, modifiers, and overlays
retain their own keys. Keyboard text selection shares native capture with a 275 ms
debounce. Whole-file/general comment buttons and explicit quote actions focus.
In a focused editor, Escape cancels an empty note or blurs a populated one without
losing text. Outside the editor, Escape hides a visible desktop discussion panel;
when the panel is hidden, it cancels an empty standalone note.
Scrolling or collapsing the selection dismisses transient quote actions, not drafts.
The standalone desktop composer has a grip to drag it. Its chosen position lasts while the
composer is open, independently of the draft's target and text. The card stays
within the viewport when moved, when its contents grow, and when the window
resizes; a new opening starts beside the selected content again.
An empty note can retarget; a populated note offers **Quote in note**. Selection in
an agent message offers **Quote in comment** only for that message's own thread.
On coarse pointers, selection first offers **Add comment**, or **Quote in note**
for a populated note. The action captures its range before tapping can clear the
native selection. Preview controls use the visible part of their iframe, including
full-height Markdown; the parent translates bounded geometry for the composer.
Focus and draft actions travel only on the current document's port while its frame
has focus. They do not send threads; publication and conversation mutations retain
their existing explicit actions and guards.

Rendered selection and Locate share text normalization. A dynamic element may no
longer exist in the current page state; the thread and captured context remain
readable, and unavailable or ambiguous placement is explicit. Published bytes do
not freeze runtime form values, modals, or device frames.

A comment's inline references use its own target's published version and view when
present, otherwise the thread's original target. A general thread stays
unbound until a comment supplies a version target; it never silently means latest.
There is no separately chosen message context. Historical comments retain their
recorded reference context.

### Comparing proposed fixes

An agent comment offers **Compare** when both the thread's immutable original
target and that comment's explicit fix target are both rendered element locators
or both media targets with saved frames in retained publications. General, whole-document, source/diff, and unavailable
publication targets do not qualify. Comment context and placements never substitute
for either target. Each eligible comment identifies its own comparison, including
multiple fixes on one thread or two targets in the same version.

Compare slides the artifact off to the left and brings in independently scoped
Original and Proposed fix previews from the right. Both use the existing preview
gate, opaque sandbox, native document path, and recorded route. Runtime matching
reports located, ambiguous, or unavailable elements; stored selectors cannot prove
that dynamic application state still contains the element. Such a failure keeps
the conversation and its evidence readable. Targets toggles highlighting; Focus
retries locating after interaction. Desktop supports side-by-side, stacked, and
narrow previews. Phones select one of the two mounted previews.

Media comparison shows the saved full frames and one normalized box per side.
Original and fix can use different timestamps, dimensions and filenames. Playback
and seeking are independent; **Return to targets** restores both saved frames.
The saved-frame icon is in each file header. Compare has no region creation tools.

The navbar and discussion panel remain shared with the artifact workspace. Comparison
adds a badge by Discussion and filters its Active/Resolved queues to eligible
conversations. The panel is temporarily docked and cannot float or hide; phone
thread is in flow beneath the previews. Comments, resolution, undo, handoff, and
draft storage use their ordinary behavior. New comparison comments default to the
explicit fix version; existing draft context remains pinned.

Returning reverses the slide and restores the previous panel mode, floating
geometry, discussion tab, scroll, and focus. The main document stays mounted and
inert during comparison, preserving its page state and selected publication.
Comparison scroll does not replace its saved reading position. Offscreen previews
cannot invoke workspace actions or use human activation to mutate conversations.
The `compare` workspace query parameter names a comment, supporting Back/Forward and
reloads. New publications do not retarget an existing comparison. Reduced motion
removes the slide; comparison previews are released after the return transition.

## Agent collaboration and lifecycle

The bundled backend serves one human who collaborates with multiple logical agent sessions.
Other backend implementations may serve multiple users; client authorization is opaque. Distinct agents,
including subagents sharing a harness, use distinct session IDs. Attribution survives
process disconnection. Sessions are neither user accounts nor artifact ownership;
any registered agent can contribute through the owner's API.

Claims are renewable, thread-scoped leases. Different agents can handle different
notes concurrently. A conflicting live owner blocks a claim, and a successful comment
releases only its author's claim. Concurrent publication is protected separately by
the version sequence check.

An artifact can retain a publisher fallback and an explicit registration. Its
selected recipient receives wake notifications: explicit listen/watch takes
priority over the publisher fallback. Each newly committed publication updates that
fallback even while an explicit recipient is selected. Unsupported publishers and
`--no-listen` clear it; publication replay changes no registration. Unlisten removes
the caller's roles. A failed worker send retains the selected subscription with a
visible error; the same attempt is never resent to another recipient.

Local and remote modes use the same backend protocol. The server owns content,
threads, authentication, and recipient selection. A separate persistent worker
owns local Claude Code/Codex delivery and opens only a private Unix socket. CLI
reads, writes, uploads, and watch go directly to the selected backend. Each backend
gets one outgoing worker connection carrying opaque destination IDs. Harness paths
and credentials remain in private local worker state.

Disconnect leaves backend subscriptions selected and reports unavailable delivery.
The persistent worker reconnects transport under the same credential principal,
without a saved recovery intent or a conditional resume request. Fresh listen can
replace the explicit subscription; an older worker cannot take it back on reconnect.
Backend restart preserves the same subscription identities. Archive, unlisten, and
replacement end those identities permanently, including while a worker is offline.
Setup, restart, and fallback selection never submit pending comments.

After printing and acknowledging pending comments, `comment fetch` registers a
supported calling harness through the same worker/backend path. Setup failure warns
without failing the fetch. History and human reads skip registration. Codex delivery
reports queue acceptance, not proof of session liveness. Notifications are bounded
and ordered per destination; a failed backend cannot block others.

The [remote protocol](remote-protocol.md) owns backend selection, client login,
credential storage, wire messages, recovery, delivery limits, and migration. The
bundled server implements that contract; it is not a separate remote product.

Comment acknowledgment records the owner's handoff, not a read receipt from every
agent. Agent messages start delivered; human comments wait for handoff. Reading or
subscribing is not acknowledgment. The CLI reads `comments/pending`, completes stdout output, then calls the explicit
`comments/acknowledge` endpoint with that snapshot’s required fingerprint. A persisted
revision rejects stale snapshots even after text is edited and reverted. Failed reads
or output leave content pending; an acknowledgment failure may repeat already printed
content on retry. `comments/history` provides read-only history for `--all`. The browser
copies the command without acknowledging content.
See [delivery and status](../../.claude/skills/api-surface/SKILL.md#delivery-and-status)
for edit and status-transition rules.

Archive shelves work without implying approval. Its transaction preserves an ordered
lifecycle event and optional artifact-level Comment, changes state, and clears claims.
The Comment shares the message model used by Threads, without a resolution
status. It remains in history and can be edited after restore through the common
Comment API. Editing it never rewrites the lifecycle event or the original retry input. The
collaboration module captures the selected recipient and removes both registrations
before notifications.

| Archive input | Notification | Watch result |
| --- | --- | --- |
| Blank comment | Unregister quietly | Archived, exit 0 |
| Nonblank comment and selected recipient | Send the saved event and Comment to that recipient | Archived, exit 0, with Comment |
| Nonblank comment without a selected recipient | Retain history; no automatic agent startup | Already-archived watch returns immediately with the Comment |

Archive takes precedence over pending comments and timeout. A failed notification
preserves the committed event and reports failure; an operation-key retry does not
push again. A complete acknowledged archive notification can deliver its Comment;
a truncated one leaves delivery unconfirmed. After restore, pending artifact-level
Comments join the ordinary snapshot handoff. Archived artifacts retain content, threads, status, unsent work, and
drafts. Archived artifacts are read-only: publication, metadata edits, conversation
creation/edits/deletion, comments, new claims, ordinary threads delivery,
and subscriptions are closed until restore. A comment still being prepared when
archive commits must fail rather than extend the archived conversation. Reading
retained content, restoring the artifact, and deleting the whole artifact remain
available. Restore allows work again and requires a fresh subscription.

The backend checks active state at each content mutation's commit, including after
asynchronous target and attachment preparation. Rejected writes return 409 without
changing retained content. A retry of an already committed operation may return
its original result; it does not create a new mutation. The browser disables
mutating controls and retains drafts; the static demo enforces the same boundary.
The CLI and notification worker rely on backend rejection rather than duplicating
this policy.

## Preview and communication boundary

The [browser support requirement](browser-support.md) covers stable Firefox,
Chrome, and Safari on macOS and iOS from the preceding six months, including full
interactive HTML. Browsers that cannot enforce Connection Allowlists use a
consented compatibility mode; acceptance evidence must still cover each engine
and actual Safari platforms.

Files and HTML use the same isolated rendering module. Ordinary scripts, modules,
styles, canvas/SVG charts, local forms, and published data run inside it. Source
views display escaped input without executing it.

By default the network is closed to the selected version's resources and trusted r3 preview
support. External APIs, CDNs, fonts/images/media, sockets, unrelated same-host
endpoints, redirects, and networked WebRTC are blocked. Pages must publish their
assets and dependencies. The preview is not an upstream proxy.

The server combines opaque document origins, scoped URL capabilities,
CSP/sandbox policy, and Connection Allowlists. Before loading executable content, a capability gate
verifies URL blocking and WebRTC rejection. Unsupported protected rendering stays
closed until the human accepts a browser risk warning. Compatibility mode retains
the restrictive headers and sandbox but cannot guarantee complete network blocking.
The warning explains the risk of malicious dependencies sending published files,
review conversations, or later user input. Acceptance is remembered for this r3
site in this browser. Once accepted, future previews load compatible documents
directly without a gate document, fetch probes, or a WebRTC probe. The choice
has no expiry and survives reloads, new tabs, version changes, and browser upgrades
until site storage is cleared or the user selects **Forget browser choice**. The
indicator stays amber, including on capable browsers. Authenticated context setup,
secure transport, published membership, restrictive response headers, and the opaque
iframe remain required; the actual document bridge validates its opaque origin.
Transport, isolation, and verification errors never create consent. Forgetting
the choice through **Preview security** revokes open compatible contexts in all
tabs and restores blocked-mode verification.
Persistent storage, workers, nested frames, camera, and microphone are unavailable
in protected previews.
Granting a device permission to the transport origin cannot enable direct iframe capture.

Only HTML artifacts offer **Allow external access** in trusted workspace UI.
Confirmation explains that the publication's files, user input, and all this
artifact's conversations can be sent elsewhere, including by external scripts.
The choice lasts only while viewing the current version, is never persisted, and
has a visible indicator and **Restore protection** action. Changing policy
reloads the preview under a new context and revokes the old one; reverting cannot
undo data already sent. Files can use restrictive compatibility rendering, but
only HTML artifacts offer broader external access. Diffs have no rendered preview.

A shield row in the top navigation’s three-dot menu shows preview security. Green requires
verified protection for every mounted preview; amber indicates compatibility,
external access, or device permission, and red indicates sharing or an error.
Checking never appears verified. Expanding the row lists each preview's isolation,
network, and device details, with external-access confirmation, **Restore
protection**, **Stop sharing**, and **Forget browser choice** actions. Source-only
views have no security row. No security banner occupies the content pane.

External mode permits direct browser networking and skips only the network-blocking
gate checks, allowing browsers without Connection Allowlist support after consent.
CORS still applies. Opaque sandbox isolation, application authentication, scoped
content and bridge access, and denied forms and direct native device access remain enforced. CSP still
denies workers and nested frames in r3-served documents. External self-navigation
can load a replacement with workers and nested frames, inheriting the iframe
sandbox and device policy but not the preceding response's CSP. Network mode
belongs to the temporary preview context, never to
artifact metadata or a publication. The preview remains independent of any backend.

The same confirmation offers optional camera/microphone permissions, unchecked by
default. These grant only the currently connected document permission to request
capture; a remembered browser permission for r3 cannot replace that choice. Device
consent is cleared on document replacement, including an open confirmation dialog.
Network consent lasts for the selected version visit. **Permissions** edits the
current choices; a visible capture status and **Stop sharing** remain in trusted UI.
Stopping sharing, browser/OS device termination, restoring protection, navigation,
and leaving the preview revoke device consent and stop parent-owned physical tracks.

Capture stays in the trusted parent and still requires native browser permission.
The runtime adapts `navigator.mediaDevices.getUserMedia` and exposes
`r3.getUserMedia` with a bounded constraint subset. A send-only WebRTC relay supplies
actual audio/video tracks to the opaque document. External access is required;
shared media may be sent elsewhere. No device endpoint, persisted grant, enumeration,
screen capture, or application credential is exposed. Returned tracks support
media consumers and coordinated stop/clone behavior, not the entire native capture
API. The [HTML authoring guide](html-authoring.md) owns usage and
compatibility limits.

The [security reference](../../.claude/skills/security-model/SKILL.md#preview-host)
owns enforcement details; [verification](verification.md) owns browser evidence.

Pages may import `/r3/utility.js` to use the narrow
[ArtifactUtility interface](../../shared/preview-protocol.ts): context, threads,
thread creation, comments, explicit Submit, change subscriptions, theme preference, and device capture. These use
the same conversations and handoff as the built-in panel. Human mutations require
user activation. The bridge validates the exact iframe window, opaque origin,
context, and document scope before accepting a transferred MessagePort. Comments
stay on that document's port across navigation; it exposes no generic API, actor override, publication, lifecycle, or host
execution capability. Pages work without importing it.

`getTheme()` reads the artifact's browser-local `light`/`dark` preference (or null);
`setTheme(theme)` saves it after a user gesture. The preference survives reloads and
publication changes on the same r3 origin. It does not change r3's application theme,
grant storage access, or accept an arbitrary key or artifact ID. The UI showcase
uses this preference for its theme button; publishers choose whether to use it.

### Static demo previews

The GitHub Pages demo substitutes a renderer at build time. Only its bundled HTML
examples and retained Markdown documents can execute; the selected artifact,
version, content hash, and path must match a bundled publication. Conversations,
publications, message images, and draft references stay in memory for the page visit.
Reload restores the original examples; saved practice state is ignored. Executable
preview bytes and assets always come from the bundle.

Each document uses an opaque `srcdoc` iframe with `sandbox="allow-scripts"`.
Bundled styles and images are embedded, document links stay within the publication,
and CSP restricts resource requests. A document-scoped MessagePort reuses native
rendered targeting, Locate, Markdown theme, and full-height layout. The demo labels
these previews as bundled examples; it does not claim verified network blocking
or offer device access. Production preview contexts and their capability gate are
unchanged. The [distribution reference](../../.claude/skills/build-and-distribution/SKILL.md#the-frontend-only-demo--github-pages)
owns the build alias and Pages layout.

## Upgrade and scope boundaries

Startup upgrades artifact schemas while preserving immutable publications and
already-imported conversations and evidence. Direct upgrades from the retired
live-review store require r3 1.5.0 first. The current server has no local-source
capture adapter. The [migration reference](schema.md#artifact-schema-upgrades)
owns supported upgrades, backups, and recovery.

Builds, dependency installation, server-side application execution, backend hosting,
deployment orchestration, multi-user permissions, recipient fan-out, automatic
cross-view mapping, root-relative rewriting, and history-route fallback are outside
this feature. Local operation and remote publishing use the same artifact model.


## Images in conversations

Thread and comments accept up to four static PNG/JPEG attachments, each at most
5 MiB and 20 megapixels. Text may be empty when an image is present. An attachment
belongs to its message, independently of the immutable original target or comment
fix target. A screenshot's version/path/route/viewport/crop is observed context,
not a selector, source location, or claim of reproducible dynamic page state.

The composer accepts user-initiated paste and image file selection. Browser inputs
are normalized to static PNG; WebP input is also accepted by that normalization.
If an input within the existing byte/pixel limits expands beyond 5 MiB during
normalization, the workspace opens an optimization preview. The original input
stays transient while the user crops or chooses a smaller PNG size. Pending
optimizations survive desktop/phone layout changes, queue for multiple imports,
and cancel on workspace exit or image-data revocation. Cancel removes only that
pending image and its placeholder. Reload before acceptance retains interrupted
draft evidence and asks for reattachment; raw source bytes are never persisted.
Thumbnails have Edit image and Remove controls; posted images open in a modal viewer.
Each addition inserts a message-local `[image1]`, `[image2]`, etc. placeholder with
spaces around it. Paste inserts at the cursor and preserves accompanying plain
text, before image preparation starts; subsequent typing stays intact. File
selection uses the retained caret and captures append to the draft. Removing an
image removes its references and renumbers later references and thumbnails;
replacing its bytes retains its position. Agent output uses the same labels.
The same controls serve notes, comments, message edits, floating composers, and the
mobile sheet. Pending or failed images count as draft content and block posting
until prepared or removed. Images do not silently replace a populated target.

Draft metadata stays in the existing per-slot localStorage records; binary bytes
live in IndexedDB. Successful image storage precedes persisting its reference.
Storage failure leaves an in-memory draft with an explicit reload warning. Posted
or discarded references become eligible for cleanup after a 24-hour grace period;
referenced drafts are not evicted. Logout and artifact deletion revoke local image
bytes; an epoch prevents late work from repopulating storage across tabs.

HTML previews offer Capture area where current-tab Region Capture and still-frame
capture are available. Its single camera icon sits beside Comment mode in the
navbar, is mounted only for a ready HTML preview, and is hidden when unsupported.
Capture state stays with that preview, so navigation removes the action and cancels
in-flight work. The same icon cancels a pending capture; notices use the shared
corner stack. Dismissing the pending capture notice also cancels capture.
The trusted workspace opens the browser's sharing chooser, crops the tab stream
to the preview iframe, freezes one frame, and stops every track before opening the
crop editor. Only the selected crop enters the draft. Sharing denial, wrong-surface
selection, navigation, timeout, or unsupported capture preserves the draft and
leaves paste/upload available. The browser decides which capture APIs are present;
there is no assumption of universal desktop or mobile capture support. Crop can
be selected by dragging or by entering numeric coordinates and dimensions.

Agents receive image IDs and download commands in comment output. Fetch with
`--attachments-dir` writes and verifies all selected immutable image bytes before
stdout and acknowledgment. Download or output failure leaves comments pending.
Fetching references acknowledges handoff, not proof that a model viewed pixels.

The image editor combines crop with pen, arrow, and rectangle drawings. Color and
stroke width apply to the next drawing. Pointer input uses original image pixel
coordinates at any displayed size; touch and mouse share the same gestures. Undo
and redo cover completed drawings, crop changes, and Clear drawings (up to 100
steps per editing session). A new edit discards the undone branch. Ctrl/Command Z
and Shift Z stay inside the editor and stand down in text and numeric fields.

Use image flattens drawings into the cropped PNG, with no crop mask or editing UI
in the saved pixels. Cancel leaves the draft's original image intact. Editing a
posted image creates a replacement attachment on message save; its earlier bytes
remain immutable. Drawing operations are local to the open editor, not persisted
as an editable document or sent through the preview bridge.

Optimize image offers 1–100% sizing, actual PNG dimensions and byte size, and
fit/actual-pixel preview. It is available in the editor and opens automatically
when edited output exceeds 5 MiB. Changing size invalidates the previous preview;
only the current, in-limit output can be accepted. The exact preview bytes are
saved without another encode. PNG and transparency remain the output policy;
JPEG output and lossy compression are deferred. Resized captures retain crop
evidence in the original captured pixel coordinates, including subsequent crops.


## Search and the artifact library

The library uses compact, flat rows with title, project, latest published version,
publication summary, review attention, stored content size, and recent activity.
Search and filter controls form square, flush rows with shared dividers.
Filter dropdowns use matching label and chevron edge insets with reserved space
between them, keeping native select interaction.
The result count and **Selection mode** toggle sit beside the kind filter;
there is no separate count row. Selection starts off, keeping bulk actions and
row checkboxes hidden without reserving space. Toggling slides the bulk toolbar
and checkbox columns into or out of view, respecting reduced motion; hidden
controls are inert. Leaving selection mode clears the selection.
Rows open the artifact directly. The list reserves its scrollbar space so filtering
does not shift the content horizontally. Desktop navigation holds the library views and
projects; mobile exposes those filters above the list. Recently updated is the
default sort, showing the most recently changed artifacts first. Attention first orders
active artifacts awaiting human review before agent presence and other work;
archived artifacts follow. Needs you includes active artifacts with unhandled
agent messages, independently of delivery or claims.

Search spans artifact metadata, version labels/summaries, published text, threads,
and comments. Content defaults to the latest committed publication; Include history
adds earlier publications. Conversations always retain their recorded version
context, including resolved conversations. Comments open their message context,
which can differ from the original concern and from a comment’s fix target. A
missing version or location never silently substitutes a newer publication.

Source matches open the matching file and line. Diff matches use captured rows and
native old/new coordinates; missing context is not reconstructed. HTML matches
use static text from the version’s entrypoint with rendered quote evidence;
scripts, styles, hidden markup, and companion code are excluded. CSS visibility
and script-generated content are not evaluated, so a rendered match can be
unavailable at runtime. Search snippets are plain text rendered through React.

The query is a conjunction of up to 16 Unicode word prefixes (256 characters).
The API returns counts by result type and bounded pages. Binary/invalid UTF-8
files and text files above 4 MiB are counted as excluded; no partial file is
silently treated as complete. The first search lazily indexes selected publications
from immutable blobs. Search does not fetch publisher paths, execute documents,
acknowledge comments, or register a listener.

Query, project, view, kind, result type, history, sorting, and page are encoded in
the library URL. The header’s r3 link preserves this state; same-tab return
restores list scroll. Native links support browser Back and opening new tabs.
Search supports its visible focus shortcut and list-local arrow navigation,
while other fields and overlays retain their own keys.


## Usage and library cleanup

The home header's statistics control opens a floating window shared in meaning
with `r3 stat`. Current library totals show artifacts by state and kind, published
versions, open/resolved threads and comments, deduplicated content size, and
cleanup eligibility/reclaimable content. Activity switches between 14 daily
buckets and four weekly buckets, using the displayed server timezone. Weeks
start Monday; the current period is partial. Counts survive deletion; earlier
history seeded from surviving data is explicitly marked incomplete.

Settings offers **Clean up archived artifacts**, showing a preview before
confirmation. Manual cleanup respects the persisted archive TTL (30 days by
default); single-artifact **Delete artifact** and home-page **Delete selected**
remove content immediately after confirmation, independently of TTL.

Home selection uses artifact identity, so repeated search matches share a
checkbox state. **Select page** covers unique artifacts on the visible page.
Changing filters or page also clears selection. **Archive selected** confirms the
selection and offers one optional message for each current listener; already
archived items are skipped without changing their timestamp. Both bulk actions
continue after failures, report results, and retain failed items for retry.
Notification failure is reported separately from a committed archive.

## Media thread targets

Files artifacts support native targets for video and static PNG, JPEG and WebP.
GIF, APNG, animated WebP and other image formats retain whole-file threads.
The file header has an **Add image comment** or **Add video comment** action
separate from whole-file threads.
This single media-comment button freezes the frame and enables targeting. Click
the frame (or press Enter) to accept the full frame, or drag one region to accept
that rectangle. The gesture opens the composer with its saved snapshot; Escape
or toggling the button cancels targeting. A temporary hint explains click versus
drag. There are no separate full-frame/select controls, extra selection toolbar
below the media, or target-editing link in the composer.
The accepted region overlay follows its draft: cancelling, discarding, clearing
the target, or posting hides it. Locate and comparison can still show saved targets.
Image and video headers also offer zoom out, a percentage button that resets to
fit, and zoom in. Zoom ranges from 25% to 800% of the fitted view. Above 100%,
dragging or focused arrow keys automatically pan the enlarged media within its
bounds. Region selection temporarily takes over dragging; panning resumes when
targeting ends. Returning to fit restores ordinary touch scrolling over the media.
Zoom in, zoom out, and reset use a quick 150 ms ease-out transition, disabled for
reduced-motion preferences. Drag panning follows the pointer immediately. Starting
a pan or region gesture finishes any zoom transition before reading coordinates.
Media tools wrap within the header when space is limited; Viewed and whole-file
threads remain together at the far right, after the media tools. Playback controls stay
outside the transformed frame and show the displayed video's timestamp; file and
comparison headers omit it. Zoom and pan are local to each viewer, including
each comparison pane, and never crop or change saved evidence or intrinsic region
coordinates. Reset zoom, Locate, and Return to targets restore a centered fitted
view. Legacy image previews retain their isolated iframe inside the same view
transform; audio controls have no visual zoom.
The default is the entire intrinsic frame. A region is one normalized rectangle,
excluding player controls and letterboxing. Activating media thread freezes the
visible pixels; completing the click or drag accepts them into the persisted draft.
Seeking, view changes and reload do not retarget the accepted draft. A populated
draft must be posted or discarded before accepting another target.

Capture pauses video and synchronously copies its decoded pixels to canvas before
encoding. The full unannotated PNG is stored with the accepted target and is what
the agent downloads. The exact unrounded browser time is retained for navigation;
the display rounds to milliseconds. Seeking alone is not an exact-frame guarantee.
Snapshot limits match comment images: 5 MiB and 20 megapixels. Frame evidence has
no edit/remove action; clearing the draft target removes its draft reference.

Only native raster/video decoding runs in the trusted app, using authenticated
published bytes and revocable local blob URLs. Executable documents, SVG and other
media continue through their existing isolated previews. Saved frames use the
existing authenticated attachment endpoint. The server checks publication and
media membership, still-image animation, timestamp shape, rectangle bounds, and
snapshot raster structure; it does not claim to prove a submitted snapshot was
decoded from that video. The recorded snapshot is the accepted evidence.
