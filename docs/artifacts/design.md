# Artifact design

r3's implemented model is **Artifact → Version → Content**, with feedback and
replies attached to the artifact. Reviewing is an activity on that work product.
This document explains the product boundaries and the reasons behind them.

Use [the domain glossary](../../CONTEXT.md) for canonical terms,
[the schema reference](schema.md) for storage constraints and migration,
[verification](verification.md) for acceptance checks, and the
[API reference](../../.claude/skills/api-surface/SKILL.md) for routes and commands.
The public wire types live in [shared/artifacts.ts](../../shared/artifacts.ts).

## Three kinds, one publication model

| Kind | Published content | Workspace |
| --- | --- | --- |
| `files` | A complete directory with at least one file | All files in one scrolling pane with foldable headers and a synchronized file browser; Markdown opens rendered, other text opens as source, with per-file HTML/Markdown view switching, media previews, and downloads |
| `html` | A complete directory with a root `index.html` | Rendered entrypoint and feedback panel; no file browser or source toggle |
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

Files artifacts use the file panel's tree order throughout the content stack and
file navigation: visit folders before files at each level, sorting siblings
alphabetically. Folding a folder in the panel does not reorder or hide its content.

A diff keeps its sparse patch payload. Removed lines, hunk gaps, rename metadata,
and binary markers cannot be represented by a fabricated complete directory.
Publication order does not imply patch application: version 2 need not apply on
top of version 1. Diff rendering produces HTML for display while retaining native
old/new target semantics.

All kinds share version identity, conversations, claims, owner handoff, and
active/archived lifecycle. Files and HTML own their members directly; there is no
additional directory-container entity for a caller to create or manage.

Artifacts have a title and metadata, with no overview field or overview panel.
Optional summaries belong to immutable versions and appear as the selected version's
description in the navigation's details popup. Descriptions have no body section or
comment anchors. New feedback targets artifacts or documents; reply fix targets
identify documents. Retired overview and version-description targets remain readable
historical evidence.
Locate on an existing description thread opens that version's details popup. Saved
description drafts retain their text and quote until the user clears or replaces the target.

Opening an artifact uses a centered loading spinner in the application's current
light/dark theme, with a static indicator when reduced motion is requested. A
rendered preview stays covered and unfocusable through verification until its
document is ready. Setup frames never add browser history entries; native links
within a published document keep their ordinary Back/Forward behavior.

## Publication and content ownership

The publisher captures local input and sends complete bytes. The daemon owns the
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
2. The daemon validates kind, paths, membership, sizes, and patch syntax, prepares
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
one preview endpoint, automatically using the browser's application address.
An optional endpoint override adds a separate loopback preview listener; no
wildcard DNS is needed. Its `files/<path>` resources use that version's content;
`r3/` serves trusted preview support. Documents use `sandbox="allow-scripts"`
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

## Reading, selecting, and locating

The browser pins the displayed version. A new publication is announced with an
**Go to the latest version** action; it does not replace the content being read. Version switches
and representation toggles preserve a draft's original target and message context.
Artifact links can include `version`, `file`, `view`, and `feedback` query parameters.

Rendered Markdown follows r3’s selected light/dark appearance, including its syntax
palette. Trusted preview support applies explicit text/background colors and adapts
legacy OS-dependent palette rules in memory; retained document bytes stay immutable.
Authored HTML keeps its own appearance.

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
publisher scripts, images, network requests, links, and feedback actions are absent.
The normal interactive document replaces it once the gate and layout are ready.
There is no additional login check and no display before application bootstrap.
Cold visits retain the loading indicator. Definitive failures remove the reading
view; cached bytes never bypass authorization for server access.

The current temporary preview capability supplies retained bytes on a cache miss.
A server-served empty Markdown shell retains response security headers and the
native document URL. After the browser gate, the trusted parent sends the selected
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

Protected document context identities are retained per tab so reopened previews
can reuse their URLs. Every reopening authenticates renewal and repeats the gate;
external-access and device grants never persist. Deletion clears app content state
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
feedback-panel toggle precedes comment mode and the three-dot menu on the right.
HTML artifacts have no empty content toolbar. File-tab headers contain reading and
feedback controls. Narrow headers show source/rendered icons and the Viewed checkbox
with accessible names, preserving space for filenames. Enabled reading controls
remain legible; touch hit areas grow within the compact header rows. Binary and oversized source placeholders offer **Download file**
in the content body.

Rendered Markdown in file artifacts expands to its natural document height within
the file stack. The main content pane owns vertical scrolling; width changes and
late-loading images resize the card in both directions. Only retained Markdown
members can report height through the current verified document port. HTML and
media keep their viewport layout, including Markdown documents viewed within HTML artifacts.
This presentation behavior does not rewrite retained document bytes.
Comment controls stay inside the visible part of a tall frame, clear of sticky
file headers, and follow the outer scroll position. Rendered Locate waits for file
hydration, header alignment, and initial Markdown sizing before jumping to its target.

The feedback dock retains the compact **Active / Resolved** tabs. Its Add general
feedback button shares the bubble-plus icon with whole-file feedback. Resolve has
neutral text and no visible outline at rest; hover adds a green border, text, and tint.
The status tabs and their sliding highlight use the same corner radius as buttons.
Active and Resolved are persistent adjacent queues. A 220 ms horizontal slide puts
Resolved to the right of Active; reversing a switch reverses the movement. Each
queue keeps its scroll position and editors. Inactive content is inert and hidden
from accessibility APIs. The new-feedback composer belongs to Active and moves
with it; an anchor gesture or Add general feedback opens Active. Reduced motion
switches immediately. Row insert/delete/reorder animations stay within each queue.
Transient background read failures retain the loaded workspace. Definitive missing
artifact or access errors replace it with an error state.
Resolve and Reopen update the queue immediately while the server saves. Pending
decisions are applied over refreshed server state, so incoming replies remain visible.
A failed save restores that thread and shows its error without rolling back other
decisions. Handoff waits for pending status saves; only the server persists status.
Active threads prioritize freshly posted human notes (unsent, with no replies or
claim), then unhandled threads, then waiting threads, then claimed work. Each
group sorts by creation time, newest first; equal timestamps preserve reverse
server insertion order. This keeps a new card beside its composer until handoff,
while replying moves a handled card below threads still needing attention. The
existing reorder animation shows that move without automatic scrolling. Unhandled
means an open thread whose latest message is from an agent; a posted human reply or
resolution clears it. Opening the panel does not. The navbar feedback button shows
one primary-color dot only when there are unhandled agent messages. Draft and unsent
counts stay in its tooltip and accessible description without lighting the dot.
The browser tab favicon adds a blue dot for the current artifact's same unhandled
agent feedback. Viewing the tab does not clear it; a human reply or resolution does.
Leaving the artifact restores the ordinary icon, including if its badge asset is
still loading.
Unsent human input also shows a desktop navbar handoff button immediately before
the feedback toggle, available while the panel is hidden. The panel retains its
handoff control, including on mobile; both controls share the in-flight request
guard and delivery receipts. Navbar handoff errors and clipboard instructions remain
visible beside that action. Posting adds feedback to r3; **Send to agent · N**
or **Copy prompt · N** explicitly hands off the pending batch. Successful notification
delivery shows **Sent** for three seconds, then hides the navbar action and keeps
the panel button disabled until new human inputs are pending. A browser receipt covers exactly the inputs present when
the ping began; concurrent edits remain eligible. Agent replies, claims, and body
edits do not invalidate that receipt. Receipts synchronize across tabs and retain the latest successful request, so
older completions cannot overwrite newer input and historical values can be sent again. A bounded cache persists hashes; if Web Crypto is unavailable,
exact inputs stay in memory for the current visit. This confirmation never stamps
server feedback as read. Failed or absent delivery remains retryable. Disabled handoff
reasons remain in the button tooltip. The draft badge shares the filter row, so
typing does not add a row or shift the composer. General notes open on demand as
the first pending card in the same scrolling list as feedback. After the server
confirms a new note, its returned record enters the cache immediately and replaces
the composer at the top. The outgoing composer crossfades into the saved card while
its height eases to fit; Cancel and Discard keep the ordinary removal animation.
Reduced motion skips the transition. Failed saves retain the draft. Event-stream
reads that arrive before the POST response cannot duplicate or overwrite the note.
Agent messages keep their attribution inside tinted bubbles; human messages omit
the redundant author label. General feedback has no location heading. Card target
and fix labels omit the version only for the latest publication;
older versions remain explicit. These labels omit representation words, retaining
paths, line ranges, and diff sides. HTML reply fix links instead show the agent's
plain-text `locator.label`, with **Page element** (or **Page** for a whole-page
target) as the legacy fallback. Their tooltip exposes the version and selector;
the published path stays in the target. Stored context and Locate behavior never change.
Replies omit a separate context label; their saved context still pins inline file
references, and explicit fix links remain visible.
Quoted targets offer expansion only when the text exceeds the three-line preview;
the control rechecks clipping when the panel resizes.
Long conversations fold earlier replies. Nonempty drafts block handoff until posted or discarded. Drafts
for deleted threads are removed; resolving or archiving keeps them. Folding the
dock or closing the mobile sheet disables its conversation shortcuts.

The desktop feedback panel has three persisted display states:

- **Hidden:** the content fills the workspace; anchors can open individual threads.
- **Expanded** (default): the original side panel reserves space beside the content.
- **Floating:** the panel initially overlays the right side of the content, below its toolbar.
  Drag its header or grip to move it; drag any edge or corner to resize. Position
  and size persist separately from the docked width. Restored geometry is clamped
  inside the available workspace. The grip and bottom-right handle also accept
  arrow keys (10 px, or 50 px with Shift). Mobile keeps its existing sheet.

Hidden and floating reserve no content space, so switching between them or resizing
the floating panel never changes content or preview width. Expanded reserves the
panel's width and resizes content with it. Visible panels offer **Float feedback** / **Dock feedback** and **Hide feedback**. Hide uses a right chevron when docked and a close icon when floating. The desktop navbar button or `p` hides the panel or
restores the last visible mode. That choice persists across reloads. All states keep
the panel mounted to preserve UI state and drafts. Existing folded preferences become
hidden and reopen expanded if no visible-mode preference was saved.
`Esc` hides either visible desktop mode while preserving drafts. Editors and open
popups handle Escape first. With the panel open, `n` opens Active and focuses general
feedback, retaining any populated draft's existing target.
These shortcuts stand down during text entry, modal overlays, and key repeat.
Float/dock changes animate the existing panel shell for 360 ms from its current
visual position and size, including corners and shadow. Content takes its final
width immediately. A rapid reversal starts from the in-progress position.
Floating hide/reveal fades the existing shell for 200 ms in its retained rectangle;
the hidden panel is inert and reserves no space. A floating hide that interrupts a mode
change fades from its current visual position instead of jumping to the dock. Direct drag/resize,
viewport resize, and reduced motion end the transition; saved geometry remains
independent of these temporary visual transforms.
The default feedback width is 38.2% of the workspace (the golden-ratio split),
within the 300–700 px resize limits. Double-clicking the divider clears the saved
width and recalculates this proportion for the current workspace in either visible mode.

With the panel hidden, selecting an existing source/diff anchor or rendered
comment marker opens only that conversation in a floating card. Reply and status
actions reuse the same thread component and draft store. Closing the card keeps
drafts; **Open all feedback** restores the full panel in its last visible mode. Changing version or view
closes the card. Mobile continues to use its shared feedback sheet.

Feedback cards retain their original motion: a quick fade with a 250 ms rise on
insertion, a 200 ms fade/slide to the right on removal, and a 200 ms move between
positions when reordered. The Active/Resolved fill eases in and out between measured
tab boxes over 380 ms, stretching to 118% width and flattening to 85% height at the
midpoint before settling to the selected tab. Labels stay unscaled; an interrupted
transition reverses from its current position and shape.
Reduced-motion preferences disable these animations.

Rendered comment mode intercepts element picks before page handlers and supports
selecting a parent element. `c` toggles comment mode from the workspace or a focused
document preview. With a node picked, `Space` invokes **Comment here** and opens the
feedback editor for that node. Text entry, modifiers, IME, overlays, and held keys
do not trigger these actions. Normal mode preserves page interaction. Source and
diff selections use their own range gestures. Each creates a native target:

| Target | Evidence | Locate behavior |
| --- | --- | --- |
| Source | Published path, version, source range and quote | Open that source view and range |
| Rendered | Published document/version, selector, optional text/context, route and viewport | Open that rendered document and locate its element/text |
| Diff | Patch version, path, old/new side, captured range and quote | Open that patch and native side, hydrating or expanding retained context as needed |

Artifact-wide notes and whole-document/file targets are explicit variants.
Summary targets survive only as historical evidence; new comments and placements
cannot use them. Absence of version context never secretly means latest.

Feedback's original target is immutable. Additional **placements** record a target
and `anchored|ambiguous|unplaced` result for a version, path, and representation.
They do not replace the original or duplicate the conversation. Source and rendered
placements for the same file/version can coexist.

Rendered Markdown feedback addresses visible content directly. For example, a note
on a link label does not need a computed Markdown source range. Its thread appears
in both views, and Locate returns to the rendered view where it began. Source notes
work symmetrically. Exact cross-representation matching is not required.

Text selection in source, diffs, rendered Markdown, and HTML works outside comment
mode. Inputs, textareas, selects, and editable regions are excluded. Selection and
gutter gestures open an unfocused composer, preserving
native Copy. Space or forward Tab focuses the visible new-note composer at the end;
Shift+Tab, editable fields, keyboard-focused controls, IME, modifiers, and overlays
retain their own keys. Keyboard text selection shares native capture with a 275 ms
debounce. Whole-file/general feedback buttons and explicit quote actions focus.
In a focused editor, Escape cancels an empty note or blurs a populated one without
losing text. Outside the editor, Escape hides a visible desktop feedback panel;
when the panel is hidden, it cancels an empty standalone note.
Scrolling or collapsing the selection dismisses transient quote actions, not drafts.
An empty note can retarget; a populated note offers **Quote in note**. Selection in
an agent message offers **Quote in reply** only for that message's own thread.
On coarse pointers, selection first offers **Add feedback**, or **Quote in note**
for a populated note. The action captures its range before tapping can clear the
native selection. Preview controls use the visible part of their iframe, including
full-height Markdown; the parent translates bounded geometry for the composer.
Focus and draft actions travel only on the current document's port while its frame
has focus. They do not send feedback; publication and conversation mutations retain
their existing explicit actions and guards.

Rendered selection and Locate share text normalization. A dynamic element may no
longer exist in the current page state; the thread and captured context remain
readable, and unavailable or ambiguous placement is explicit. Published bytes do
not freeze runtime form values, modals, or device frames.

A reply has an explicit version/representation context for its inline references,
plus an independent optional fix target. It can discuss rendered version 1 while
pointing to a source fix in version 2. References needing different message contexts
belong in separate replies. Publishing and replying leave feedback status under
human control.

## Agent collaboration and lifecycle

One human owner collaborates with multiple logical agent sessions. Distinct agents,
including subagents sharing a harness, use distinct session IDs. Attribution survives
process disconnection. Sessions are neither user accounts nor artifact ownership;
any registered agent can contribute through the owner's API.

Claims are renewable, feedback-scoped leases. Different agents can handle different
notes concurrently. A conflicting live owner blocks a claim, and a successful reply
releases only its author's claim. Concurrent publication is protected separately by
the version sequence check.

One designated listen/watch recipient receives owner handoffs. The publisher-side
listener connects outward and invokes its local harness adapter. The daemon receives
logical identity and delivery results, not harness sockets, executable paths, or
credentials. Any harness can use `watch` or `feedback fetch` without an automatic wake adapter.

Delivery records the owner's handoff, not a read receipt from every agent. Agent
messages start delivered; human feedback/replies wait for handoff. Reading or
subscribing is not acknowledgment. The exact pending snapshot is acknowledged by
prompt POST; manual copy sends a fingerprint after successful clipboard writing.
See [delivery and status](../../.claude/skills/api-surface/SKILL.md#delivery-and-status)
for edit and status-transition rules.

Archive shelves work without implying approval. Its transaction preserves an ordered
lifecycle event and optional message, changes state, and clears claims. The
collaboration module captures and removes the current listener before notifications.

| Archive input | Notification | Watch result |
| --- | --- | --- |
| Blank message | Unregister quietly | Archived, exit 0 |
| Nonblank message and listener | Send the saved event/message to that listener | Archived, exit 0, with message |
| Nonblank message without listener | Retain history; no automatic agent startup | Already-archived watch returns immediately with the message |

Archive takes precedence over pending feedback and timeout. A failed notification
preserves the committed event and reports failure; an operation-key retry does not
push again. Archived artifacts retain content, threads, status, unsent work, and
drafts. Publication, new claims, and ordinary handoff are blocked, while in-flight
replies are accepted. Restore allows work again and requires fresh registration.

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
site in this browser; every new preview still attempts verified protection first.
Transport, isolation, and verification errors never trigger the fallback. Forgetting
the choice through **Preview security** in the navigation menu stops open
compatible previews, including other tabs.
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
feedback creation, replies, explicit Submit, change subscriptions, theme preference, and device capture. These use
the same conversations and handoff as the built-in panel. Human mutations require
user activation. The bridge validates the exact iframe window, opaque origin,
context, and document scope before accepting a transferred MessagePort. Replies
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
version, content hash, and path must match a bundled publication. Browser storage
retains conversations and publication state but cannot supply executable preview
bytes or assets.

Each document uses an opaque `srcdoc` iframe with `sandbox="allow-scripts"`.
Bundled styles and images are embedded, document links stay within the publication,
and CSP restricts resource requests. A document-scoped MessagePort reuses native
rendered targeting, Locate, Markdown theme, and full-height layout. The demo labels
these previews as bundled examples; it does not claim verified network blocking
or offer device access. Production preview contexts and their capability gate are
unchanged. The [distribution reference](../../.claude/skills/build-and-distribution/SKILL.md#the-frontend-only-demo--github-pages)
owns the build alias and Pages layout.

## Upgrade and scope boundaries

The artifact protocol replaces the live-review API and commands. Legacy files and
scratch reviews become files artifacts; surviving patches remain independent diff
versions. Migration preserves identity, conversations, delivery, and known native
references, while explicitly retaining uncertainty and missing-history evidence.
A one-time current capture is labeled nonhistorical. The
[migration reference](schema.md#migration-from-legacy-reviews) owns defaults, backups, and recovery.

Builds, dependency installation, server-side application execution, backend hosting,
deployment orchestration, multi-user permissions, recipient fan-out, automatic
cross-view mapping, root-relative rewriting, and history-route fallback are outside
this feature. Local operation and remote publishing use the same artifact model.
