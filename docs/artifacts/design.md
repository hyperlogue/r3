# Artifacts in r3

Status: approved in r3 review `review_a59bb3951ec7`, publication 8. Implementation is tracked in [Progress](implementation.md). Artifact is the central entity. The destination schema keeps product constraints strict; migration supplies documented defaults for missing legacy fields. Published directory versions require at least one file.

## Product model

Artifact replaces Review as r3's central entity. Feedback and Reply remain the conversation model attached to an artifact. Reviewing is an activity performed on an artifact.

There are three kinds:

| Kind | Published content | Main experience |
| --- | --- | --- |
| files | A directory of files, with no entrypoint | File browser and file viewer; source first, with a rendered toggle where supported |
| html | A directory of files with an index.html or index.md | Rendered entrypoint in a full-screen workspace, with no file browser |
| diff | One stored unified patch per publication | Existing diff presentation with old/new sides and captured context |

Files is the primitive, general-purpose artifact. Each published version contains at least one file, without imposing a document or application structure. Renderable documents initially open as source; the user can switch to their rendered presentation.

HTML specializes the experience around an agent-authored page. It can contain arbitrary supporting files, but the page must link to, embed, or otherwise use anything the user should encounter. r3 exposes no file browser, standalone companion-file viewer, or raw-source toggle in this kind.

Files and HTML share versioned file storage, publication, rendering, conversation, and remote operation. HTML adds an entrypoint and a different workspace. There is no live filesystem reload and no diff presentation in either kind. Diff shares the collaboration and version lifecycle while retaining its patch payload and side-aware targets.

Kind is explicit. An index.md inside a files artifact remains an ordinary member; its presence does not silently turn the artifact into html.

## Scope and non-goals

Agents produce files using whatever tools and process they choose. They publish them as a files artifact for browsing, or provide an HTML/Markdown entrypoint for an html artifact. Ordinary browser JavaScript, stylesheets, and assets are supported in rendered HTML.

r3 owns publication, storage, rendering, annotation, and agent communication for one human owner and multiple agents. Multi-user accounts, organizations, permissions between users, builds, dependency installation, server-side application execution, backend hosting, and deployment orchestration are non-goals.

An optional browser utility lets the HTML page communicate with an agent through r3, alongside the built-in feedback panel. It imposes no framework requirement. Pages work without importing it.

The publisher and r3 may run on different machines. The server's content and communication interfaces must support that arrangement, while retaining local operation.

## Domain model

| Term | Meaning |
| --- | --- |
| Artifact | A durable work product with a kind, content history, conversation, and lifecycle |
| Version | One immutable publication belonging to an artifact |
| Entrypoint | The index.html or index.md initially displayed for an HTML version; files artifacts have none |
| Representation | The source or rendered view of a published file; part of a files feedback target's identity |
| Rendered document | The HTML presentation whose elements and visible text are the anchor source for rendered-view feedback |
| Feedback | A note or conversation request, optionally targeted, with open or resolved status |
| Reply | A message in a feedback thread, optionally targeting where a change landed |
| Original target | The version, representation, and location where feedback was created |
| Placement | A separate mapping of feedback onto another version or representation |
| Agent session | One identifiable logical agent run; concurrent agents and subagents have distinct session IDs |
| Lifecycle event | A persisted archive or restore transition, with an optional human message on archive |

Files and HTML versions own their files directly through the same storage. There is no additional directory-container entity to create, identify, or manage. A manifest is simply the mapping from a version's paths to its bytes. An archive or multipart upload is a transport choice, not another product concept.

Artifact owns title, summary, metadata, lifecycle, feedback, replies, and working presence. Kind is fixed for an artifact so a version sequence cannot unexpectedly switch between a patch and a directory.

Every HTML version has an entrypoint. Infer it when exactly one supported index exists; require an explicit choice when both exist. The entrypoint belongs to the version rather than mutable artifact metadata. Files versions do not declare or infer an entrypoint.

## What can be unified with diff

The shared model is Artifact -> Version -> Content, with Feedback and Reply targeting content in an explicit version. Version means a publication of this artifact. It does not imply a complete repository snapshot or a change relative to the preceding version.

All three kinds share artifact identity, version identity, conversation, presence, delivery, and lifecycle. Files and HTML also share content storage. Diff introduces a different payload; source, rendered, and diff targets introduce different locators. The common interface must preserve those differences.

| Concern | Current diff behavior or constraint | Shared design |
| --- | --- | --- |
| Complete files | A patch may contain only selected hunks, deleted lines, rename metadata, or binary markers | Files/HTML versions contain files; a diff version contains the patch. Do not invent complete files or an index for a diff |
| Relationship between versions | Each round is an independent patch; round 2 need not apply on top of round 1 | A version is one publication. Publication order is not patch-application order |
| Target identity | A diff location needs its round, path, old/new side, and captured lines | Share the versioned target envelope; use typed source, rendered, and diff locators |
| Validation | Diff targets can be checked against immutable stored rows; runtime HTML elements may exist only in the browser | Validate each locator with its own content rules under the same target interface |
| Retaining versions | Current round removal deletes the patch body even when feedback or replies retain its sequence | Published versions remain visible and immutable until whole-artifact deletion; there is no individual removal or withdrawal |
| End of work | Current status, watch exits, and notifications distinguish approved and abandoned | Replace them with a shared artifact lifecycle rather than retaining approval only for diff |
| Reply references | Current ref_version is inferred from the latest round/snapshot at post time | Send an explicit message context version so a reply composed on an older version stays there |
| Content identity | Current artifacts require a local repository identity | Artifact and version lookup must work without the server resolving a client-side path |

A deleted-line comment demonstrates why a diff cannot be flattened into an ordinary HTML file target. Its subject may exist only on the old side of a sparse patch. A side-by-side/unified layout switch or context expansion must not change its identity.

Rendering a diff as HTML is useful for display, but does not replace the patch as the source of its old/new semantics. A single untyped CSS selector for every kind would lose those semantics and weaken server validation. Conversely, requiring line_start and line_end for all feedback recreates the Markdown mapping problem.

Use one artifact/version protocol with typed content and target locators. Files and HTML use the same file-content implementation; HTML requires an entrypoint. Diff uses patch content. Shared behavior lives above that seam, with source, rendered, and diff locating behind it.

## Database and HTTP contract

The existing implementation has concrete obstacles:

- shared/types.ts exposes patches and snapshots separately. Feedback.patch_seq is diff-specific; Reply.patch_seq and Reply.ref_version have different meanings.
- server/db.ts stores patches and snapshots in separate tables, and snapshot_files stores text with skipped markers for binary content. The scalar version references on feedback and replies are not foreign keys to one version table.
- server/reviews.ts infers the latest diff round for line feedback and the latest version for reply references. A client left on an older version cannot rely on that inference; files references also need source/rendered representation context.
- The current schema requires repo_id and source on every review. These cannot remain prerequisites for reading remotely published content.
- server/db.ts deletePatch deletes the body; server/reviews.ts removePatch does not protect feedback or reply references. Keeping the old behavior conflicts with durable version targets.
- Current diff sequence allocation derives its maximum from live rows and surviving references. Retained version rows and a durable counter prevent sequence reuse, including across migration of incomplete old histories.
- cli/index.ts, server/index.ts, and server/listener.ts branch on approved/abandoned. This is a protocol migration, not just a button rename.

The concrete proposal is in [Database schema and relationships](schema.md), with the executable [SQLite DDL](../../server/artifact-schema.ts). It uses one kind-checked version table instead of separate HTML/diff subtype tables.

A compact relational design can express the new rules:

| Storage | Responsibility |
| --- | --- |
| artifacts | Identity, fixed kind, active/archived state, optional project, metadata, next version sequence |
| artifact_versions | Shared key (artifact_id, seq), immutable publication metadata, publisher session, kind-checked entrypoint or patch payload, publication marker |
| version_files | Shared by files and html: relative paths, media types, byte references, and retained rendering references where needed |
| blobs | Content-addressed byte metadata shared by original files and retained renderings |
| feedback | Artifact, lifecycle, original target version/representation, and typed locator |
| replies | Feedback, message, explicit context version/representation, and an optional typed fix target |
| feedback_placements | Placement and match state keyed by feedback, version, document, and representation; separate from the original target |
| agent_sessions | Persistent attribution for concurrent agent runs; referenced by publications, messages, and claims |
| artifact_events | Ordered archive/restore history and optional archive messages, separate from feedback status |
| claims and delivery records | Feedback-scoped ownership and artifact handoff rules; no global artifact-wide agent owner |

Feedback and Reply remain separate. A reply never acquires feedback status.

A publication starts assembling inside a transaction and becomes readable only when published_at is set. Finalization checks complete file membership and HTML entrypoint existence; the database then rejects additional files or changes to version content. Archive cleanup, delivery, and native locator validation stay behind the relevant server module interfaces. The schema document distinguishes database constraints from those transaction rules.

Use foreign keys for version identity and validate that a target version belongs to the feedback's artifact. Composite keys can enforce that ownership without trusting a bare sequence number. Locator details can use validated JSON; referential identity must remain queryable and constrained outside that JSON. Validate kind before publication: files has file members and no entrypoint, html has file members and an entrypoint, and diff has its patch payload.

A content target contains an explicit version and a typed locator. A source locator names a file and a directly selected source range/quote. A rendered locator names a document and a displayed element/text range. A diff locator names a patch file, side, and captured range/quote. Whole-page/file and version-summary targets fit that version envelope. General artifact feedback and the mutable artifact summary have explicit artifact scope; null must not secretly mean latest, first round, or WORKING.

Proposed HTTP shape:

| Operation | Contract |
| --- | --- |
| Create/read/list artifacts | One resource family for all three kinds |
| Publish/list/read versions | One resource family; files/html share file publication, with an entrypoint required only for html; diff supplies a patch |
| Read version content | Shared version-specific file/document access for files and html; structured patch rendering for diff |
| Create feedback/post replies | One conversation interface with typed targets and explicit message context |
| Submit/watch/listen/claim | Shared artifact communication rules |
| Archive/restore | Shared lifecycle actions; archive accepts an optional message |
| Delete artifact | Remove the whole artifact and its owned history; no individual version deletion |

For example, publication can use POST /api/artifacts/:id/versions with the expected latest sequence and a typed payload. Files and HTML use the same file-transfer path; the declared artifact kind determines whether an entrypoint is required. The expected sequence detects concurrent publication; it does not declare the preceding version to be a patch's base.

The browser sends the displayed version and representation. CLI conveniences may resolve latest explicitly, but the server must not replace an explicit old version with latest. A reply's context and its fix target are distinct: a message can discuss rendered version 1 while pointing at source in version 2 of a files artifact. Structured references can carry their own version and representation when a message cites several targets.

Database migration is required; compatibility with old commands, routes, event payloads, and browser clients is not. Choose the target interface for the artifact model, then upgrade the daemon, CLI, agent guide, and browser together. Preserve stored work and reference identity where supported by evidence. Do not add command aliases, dual protocols, or old UI semantics just to ease the transition.

## Publication and content ownership

Every resource served from a files or HTML version comes from that version's published files. CSS, scripts, images, fonts, data, and internal document navigation follow the selected version. A missing file never falls back to another version or to the publisher's working directory.

The publisher sends the complete file membership for the new version. Omitted paths are deletions in that version, but at least one file must remain. A file may contain zero bytes; a published directory may not contain zero files. Storage can reuse unchanged bytes without exposing an extra object or upload step to the user.

Preserve Markdown-to-HTML output and rendering metadata per version for both files and html. A renderer upgrade must not silently rewrite the document that old rendered annotations address. Source views display the published input bytes as escaped code/text; HTML rendered views run the published page. Source ranges address that input directly, and rendered targets address its displayed HTML independently. Neither depends on syntax-color span structure or a reverse source map.

Publication:

1. Capture stable input on the publisher's machine.
2. Upload the version's complete content and metadata.
3. Validate paths, completeness, sizes, and kind; require an entrypoint for html only and prepare document renderings.
4. In one publication transaction, check active state and expected latest sequence, assign a never-reused sequence, and expose the complete version.
5. Notify readers that a new version is available.

Stable capture and atomic visibility solve different problems: packaging must detect changing input or capture from a prepared directory; the server must not expose a partial upload. Failed publication leaves the previous version intact. A publication identity makes retries return the existing result rather than append duplicates.

The same atomic-publication envelope serves diff versions, with patch validation replacing directory/entrypoint validation. The patch is stored as supplied; publishing does not apply it to another round.

SQLite metadata and daemon-managed byte storage are sufficient initially. Publishing-machine paths are optional provenance, never content lookup keys. All published content remains readable when that machine is offline.

## Version-local resource endpoint and URLs

Files and HTML use one immutable resource interface:

```text
GET /api/artifacts/:artifact_id/versions/:seq/files/*path
HEAD /api/artifacts/:artifact_id/versions/:seq/files/*path
```

The endpoint returns the file's bytes with the correct media type. It supports fetch/XHR, module imports, CSS resources, images, audio, and video; it is not a JSON/base64 wrapper. Provide byte-range responses for media seeking, content-derived validators, and private caching. Missing paths return 404. Reads never fall back to latest, another artifact, or a local directory; uploads/publication use a separate interface.

The isolated preview exposes the same content module through a version-scoped resource URL. Executable HTML is served there, never executed on the privileged application's API origin. Raw HTML downloaded through the application API is served as an attachment. The preview's authorization grants only the selected artifact/version; embedded image and video requests must work without exposing a master token or requiring JavaScript to attach headers. The exact preview origin and scoped-access mechanism still need implementation proof.

For example, version 3 can contain index.html, data/chart.json, images/plot.png, and media/demo.mp4. While index.html from version 3 is open:

```html
<img src="./images/plot.png">
<video controls src="./media/demo.mp4"></video>
<script type="module">
  const chart = await fetch('./data/chart.json').then(response => response.json());
</script>
```

All three requests read version 3 even after version 4 is published. XHR follows the same rule. Nested documents use normal directory-relative paths within that publication.

The earlier phrase "resolve inside the selected version" referred to this guarantee. A URL beginning with / is different: fetch('/data/chart.json') addresses the origin root and does not automatically include the version prefix. The initial authoring contract uses relative resource URLs, or a version-root URL exposed by r3 for constructing absolute resource URLs. r3 does not rewrite arbitrary JavaScript or pretend an HTML base tag fixes every root-relative request.

For initial client-side routing, use hash routes such as #/details, or actual published document paths. A history route such as /details is not automatically mapped to index.html. Universal root-relative URL rewriting and SPA history fallback are deferred; missing resources must remain distinguishable from routes.

## Files workspace

A files artifact opens a file browser and a viewer. It has no entrypoint and no required index. The browser remains the navigation surface even for a single-file artifact; selecting an initial file is UI state rather than publication metadata.

| Selected file | Presentation |
| --- | --- |
| HTML or Markdown | Source by default, with a toggle to the rendered document |
| Source code or other text | Read-only source/code, with highlighting where supported |
| Image or supported media | Appropriate preview |
| Other binary content | File information and an available download |

The browser uses the selected version's published paths and never enumerates a live directory. Internal rendering output and r3 bridge assets are not separate file entries. There is no diff view; users switch published versions to revisit changes.

Both source and rendered views support creating feedback, reading threads, replying, and locating their original targets. A view toggle never replaces a target or overwrites a draft. The same feedback list remains available in both views.

## HTML workspace

An HTML artifact opens its index.html or rendered index.md full screen. Its toolbar provides version selection, comment mode, and the feedback panel. There is no r3 file browser, individual companion-file viewer, or raw-source toggle, regardless of how many files are published.

Agents may publish arbitrary supporting files. The entrypoint and its linked pages decide what the user sees: documents can link to each other, scripts can load data, and pages can embed media or display code. A file not used or referenced by the page has no independent r3 browsing affordance.

This is a presentation rule. Shared content and agent interfaces still retrieve the published files needed for rendering, export, and editing. r3 does not need a second storage format or a static proof that every file is referenced; dynamic page code may construct resource paths.

Published links and assets resolve inside the selected version. Root-relative paths and client-side route fallback need an explicit serving policy. The page owns its navigation; the files workspace owns file navigation for files artifacts.

## Selection and navigation

In normal rendered mode the page behaves normally. Comment mode intercepts an element pick to open a thread instead of activating the element, and permits choosing a containing element. Source view uses its own text/range gesture.

New publication is announced without switching a reader who is composing. Version switches and source/rendered toggles preserve the draft's original target. Deep links identify artifact, version, file, representation where applicable, and optionally thread.

Locating a thread opens its original version and representation, then locates the target there. If runtime state makes it unavailable, show the captured context. Cross-representation matching is not required for feedback to work in both views.

## Targets across source and rendered views

Files adds one identity dimension: the representation that was actually selected. A file path and version alone cannot distinguish source text from rendered content.

| Target | Anchor source | Validating/locating it |
| --- | --- | --- |
| Source in files | Published file bytes and a directly selected range/quote | Read the selected version's file; locate in source view |
| Rendered in files or html | Displayed HTML elements and rendered text | Locate in that version's rendered document and page state |
| Diff | Stored patch rows, file, and old/new side | Validate against the version's captured patch |

Storing a source range from a source selection requires no rendered-to-source tracing. A rendered Markdown or HTML selection never acquires a computed source range. These are independent native targets behind a shared conversation interface.

For example, source might contain a Markdown link while the rendered page shows only its label. A note on the label cannot reliably highlight an identical raw-source span without mapping. The thread remains visible in both views, and Locate opens the rendered view where it was created. A source comment works symmetrically.

The original target is immutable. Any placement in another version or representation is a separate, explicit result with its own match state. Do not clone the feedback into two threads, mutate the original on a toggle, or silently assume source and rendered offsets agree.

Initially, exact locating returns to the original representation. Best-effort cross-view matching could be added later if useful, but exact highlighting in both views is not a guarantee of this design. Making that a requirement would bring back correspondence logic the new model is intended to remove.

Rendered targets retain element identity/selector, selected text and nearby context, and useful route/viewport information. Selection, locating, and highlighting share one rendered-text normalization rule. The W3C annotation model offers useful precedents for text quotes, contextual selectors, and resource state. [Web Annotation Data Model](https://www.w3.org/TR/annotation-model/)

A dynamic DOM may contain elements the server cannot reproduce. Validate target shape, artifact/version ownership, document scope, and available static evidence; retain the selected context without pretending to reconstruct application state. Missing or ambiguous targets remain readable with an unavailable placement, rather than being redirected to a convenient source line.

Agent prompts include version, path, representation, quote/element context, and any native source or diff range. Agents can download the published files to determine their edits. Reply targets explicitly identify the version and representation where the change landed. The original target, message context, and fix target remain separate.

Publishing and replying do not resolve feedback. Feedback lifecycle is shared across representations and all artifact kinds.

## HTML communication utility

An optional library lets a rendered HTML page offer its own agent controls: request a chart revision, show a conversation next to a section, or react to an agent reply. The same bridge can serve an html artifact or a rendered file in a files artifact.

The page and built-in panel use the same artifact, feedback IDs, threads, and delivery rules. The initial interface exposes:

- Context: the active artifact, displayed version, document, and representation.
- Conversations: create feedback and reply, with optional rendered targets.
- Handoff: explicitly submit user-initiated messages through the existing delivery protocol.
- Updates: subscribe to thread, reply, version, and lifecycle events.

A Send or Submit control is an explicit handoff. Reading or subscribing does not mark feedback delivered. The host validates calls and scopes them to the artifact and version; the page receives no application credentials and cannot impersonate an agent or execute host commands.

Requests to revise the artifact are messages to an agent. The utility does not run builds or manage a backend. The ordinary browser-and-panel workflow remains available without it.

## HTML isolation, network policy, and device access

Use the same isolated rendering module for HTML artifacts and rendered HTML in files artifacts. Support ordinary JavaScript, DOM updates, styles, charts, in-page forms, published modules, and published data. Source view escapes input and never executes it.

The network contract is closed: page-initiated requests may read the selected version's published resources and r3-supplied preview support files. The conversation utility communicates through the host bridge. External APIs, CDNs, analytics, remote fonts/images/media, external sockets, and server-submitted forms are unsupported. Agents must publish their dependencies and data with the artifact. r3 does not proxy arbitrary external URLs.

This is narrower than permitting every URL on the same hostname. Unrelated artifacts, versions, application routes, other ports, and arbitrary backend endpoints remain outside the page's resource scope. An isolated preview may use a dedicated r3-controlled origin for hosting; that does not grant the page permission to contact other origins.

| Feature | Contract |
| --- | --- |
| JavaScript UI, HTML/CSS, SVG/canvas charts, in-page controls | Supported |
| Published modules; fetch/XHR of version-local data | Supported through the version resource endpoint |
| Embedded images, audio, and video | Supported from the publication; media seeking supported |
| Camera and microphone | Supported through browser consent and the preview's permission delegation |
| Other browser-gated device APIs | Permitted in principle, subject to browser/platform support and required delegation |
| r3 conversation access | Scoped utility bridge |
| Requests to external hosts or unrelated same-host endpoints | Blocked |
| Networked WebRTC, external popups, and navigating the parent page | Outside the supported contract |
| r3 application credentials, unrelated private artifacts, or host commands | Unavailable to page code |

Apply server-controlled CSP to documents and applicable workers, restricting every resource class rather than only fetch: connections, scripts, styles, images, media, fonts, frames, and workers. Inline code/styles and local blob/data resources need deliberate allowances for ordinary pages. Block form submission, external frames, and popups; cover direct document navigation and redirects. CSP resource controls and sandbox navigation controls are distinct mechanisms. [Content Security Policy](https://www.w3.org/TR/CSP3/), [HTML sandbox](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox)

The no-external-network requirement needs browser integration tests, including navigation, redirects, workers, and WebRTC. Do not describe connect-src alone as a complete network sandbox. The CSP specification defines WebRTC controls, but the implementation must verify support in the browsers r3 supports and close unsupported paths before claiming complete enforcement. This is an implementation gate, not permission to silently relax the product rule. [CSP WebRTC directive](https://www.w3.org/TR/CSP3/#directive-webrtc)

Camera and microphone permission is delegated to the preview, then controlled by the browser's normal grant/deny flow; r3 adds no separate approval modal. getUserMedia requires a secure context, and cross-origin frames need permission delegation. The preview must use a suitable real origin isolated from the application instead of relying on an opaque-origin sandbox that prevents the requested workflow. Browser permission can be remembered; consent does not imply a fresh prompt on every request. [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/), [Permissions Policy](https://www.w3.org/TR/permissions-policy/)

Device permission allows local capture and processing; it does not grant network access or publish captured data automatically. Runtime state remains dynamic: published bytes do not freeze an open modal, camera frame, or user-entered value. Preview origin, scoped resource authorization, and cross-browser enforcement must be proved together before implementation is considered complete.

## Archive and restore

Lifecycle: active or archived, with Archive and Restore as user actions for all three kinds. Archive shelves ongoing collaboration without a correctness judgment or sign-off.

Archive opens a modal with an optional message, like the previous approval modal. Empty or whitespace-only input means no message. Persist each archive/restore as an artifact_events record, preserving earlier archive messages across Restore and a later Archive. An archive message is lifecycle communication, not new open feedback.

| Archive input | Registered listener | r3 watch |
| --- | --- | --- |
| No message | No agent message is pushed; unregister quietly | Terminates with an archived result |
| Message supplied | Push the archive event and message to the captured listener; registration is cleared | Prints the archive message and terminates with an archived result |
| Message supplied, no listener | Save the message; no push or automatic agent startup | Terminates with the archived result and message if watching |

r3 watch always terminates on archive, whether or not a message exists. The proposed CLI result is archived with exit code 0, optionally carrying event ID and message; it implies no approval. A watch started on an already archived artifact returns immediately. Terminal lifecycle observation takes precedence over pending ordinary feedback.

The lifecycle transaction updates state, stores the event/message, and clears claims. The collaboration module captures the current listener registration and removes it as part of the ordered transition. After commit, broadcast lifecycle updates to the browser/watch clients. Push to that captured listener only when a message was supplied. This ordering preserves the recipient while preventing later handoffs. A failed push is reported and the saved message remains readable; it does not undo archive or wake a future listener after Restore.

Use an operation key so a retried archive request returns the existing event without duplicating the transition or its normal notification attempt. Notification is not an exactly-once delivery guarantee. A successful nudge alone does not mark unrelated feedback delivered.

Archive stops new publication, claims, and ordinary agent handoff. It preserves content, feedback status, messages, unsent content, and drafts. An in-flight reply may still be recorded without reactivation. Restore enables work again; an agent must register again explicitly. The new watch and CLI contract is designed directly around active/archived, with no compatibility layer for approved/abandoned.

Publication and archive check state in the same transaction ordering. If archive wins, publication is rejected; if publication wins, that version belongs to the subsequently archived artifact. Preserve historic approved/abandoned outcomes as migration provenance while mapping both to archived.

## Version history and retention

Published versions are append-only, immutable, and always available in the version picker until the whole artifact is deleted. There is no withdrawal, hide, restore-version, or individual version-delete operation. To correct an artifact, publish another version.

Removing withdrawal eliminates its endpoint/command, withdrawn state and schema column, picker filtering, withdrawn-link UI, latest-visible-version rules, and the associated state combinations and tests. It is a useful reduction in complexity. It does not remove the need for immutable storage, stable version targets, a never-reused sequence, or whole-artifact deletion and blob cleanup.

Keep all published version content until artifact deletion. This intentionally removes today's destructive diff-round removal. Migration preserves surviving stored work and records already missing history without pretending to recover it. A future retention or selective deletion requirement would be a separate design change.

## Remote operation

The publisher captures files or generates a patch locally and sends content to r3. The server owns persisted artifact state. Neither publication nor later reading requires the server to resolve a publisher's filesystem path.

Project identity is explicit and optional for an artifact; git paths and revision information are provenance. A remote URL alone is not a project identity. Local diff-capture conveniences can remain while remote diff creation supplies the patch directly.

For notifications, an agent-side process connects outward to r3 and delivers nudges through the local harness. The remote server does not run the publisher's agent executable or contact a local session socket on that machine.

Any agent can publish, fetch versions, inspect feedback, claim work, and reply via CLI/HTTP. Automatic wake-up depends on the local harness adapter. Initial notification routing can keep one designated listener per artifact; that is a delivery choice, not exclusive ownership of the artifact or permission to contribute.

The product scope is one human owner and multiple agents. Multi-user accounts and permissions are non-goals. Detailed multi-agent assignment, fan-out, and per-recipient delivery are deferred, but attribution must distinguish agents now: agent_sessions gives each logical run a stable identity, and publications, feedback, replies, and claims reference it. Concurrent agents, including subagents, use distinct identities even if their harness shares a parent session.

Claims stay feedback-scoped, so different agents can work on different notes in the same artifact. A claim conflicts only with another live owner of that note. An agent reply releases its matching claim, not another agent's claim. Publication compare-and-swap handles concurrent publishers.

Keep role (human/agent) separate from agent session identity. Historical messages retain attribution after a process disconnects. Actor roles and agent-session references remain required where applicable; missing legacy attribution is normalized with migration defaults, recorded in provenance. Session records are not user accounts, credentials, or live listener registrations; transient transport secrets stay outside SQLite. Existing delivery fields describe the owner's artifact-level handoff, not proof that every agent read a message. If fan-out is added later, per-recipient delivery receipts must be modeled explicitly.

## Module interfaces

| Module | Responsibility |
| --- | --- |
| Artifact collaboration | Shared feedback, replies, claims, lifecycle, and delivery |
| Version publication | Atomic publication, kind validation, version identity, and retries |
| Version content | Shared files/html storage plus patch storage for diff, with versioned reads, rendering references, and export |
| Artifact presentation | Files browser/viewer, HTML page, or diff renderer; source/rendered selection belongs to the active representation |
| Targeting | Shared target envelope with native source/rendered/diff locators and placements keyed by version and representation |
| Agent connection | Remote connection and local harness delivery |

Shared callers operate on artifact/version identity and typed targets. They do not need to know whether content lives in a patch body or per-file bytes. A module's interface should hide those details while preserving the semantic differences its callers actually need.

## Implementation and migration

1. Introduce Artifact with files/html/diff kinds, common version identity, and the shared active/archived lifecycle.
2. Add shared version_files storage for files and html, html-only entrypoint metadata, and the diff patch payload.
3. Add source/rendered/diff target variants, explicit representation in message context, and version/representation-aware placements.
4. Build files publication and its browser/viewer, with source defaults and rendered toggles; retire live filesystem reads.
5. Build the html entrypoint workspace using the same publication/rendering modules, with no file browser.
6. Adapt diff to the shared immutable version history, conversation, and lifecycle interfaces while preserving patch rendering and old/new semantics.
7. Add the HTML communication library and remote publisher/listener path.
8. Convert legacy files/scratch reviews to files artifacts without requiring or generating an index.
9. Migrate the database, then upgrade commands, events, browser, and agent guide together. No old-client compatibility or aliases are required.

Legacy file reviews naturally become files artifacts. An existing index file remains a normal file unless a new artifact is explicitly created as html. No synthetic entrypoint or forced conversion to an HTML workspace is needed.

Legacy text snapshots may lack assets. Preserve incomplete historical content with explicit provenance instead of pretending it is a complete new publication. If no original file survives in a files snapshot, its migrated version contains an explicitly generated migration notice; it never relaxes the nonempty-directory constraint or presents the notice as original content. Start converted artifacts with complete published content.

Legacy live-source anchors do not prove which historical rendering was seen. Preserve their quotes and provenance. A verified source target belongs to source representation; a known rendered target belongs to rendered representation. When historical representation is unknown, retain that uncertainty rather than manufacture a reverse mapping. Record any placement onto a new publication separately.

Resolve legacy diff null-round conventions only when the original round is known. Existing approval/abandonment outcomes become historic metadata on archived artifacts. Already deleted patch bodies cannot be recovered by migration.

Migration must preserve the stored work, conversations, supported references, and honest legacy provenance. It must satisfy the target schema using explicit defaults instead of making required fields nullable. For example, an absent creator role defaults to the human owner, and a known agent without a session receives an imported session record; provenance distinguishes those defaults from recovered facts. See [Required fields and migration defaults](schema.md#required-fields-and-migration-defaults). It must not dictate the target module interfaces or require continued support for old commands, URLs, or clients. Keep shared/types.ts, database migration, server routes, browser, CLI, and r3 guide aligned. Update repository design documentation when implementation lands.

## Acceptance scenarios

- Publish a files artifact with at least one file and no index: it opens a browser and file viewer.
- Attempt a zero-file publication: reject it; an individual zero-byte file is still valid.
- Publish index.md as an ordinary files member: the artifact stays files and source opens first.
- Toggle a renderable file: source and rendered views read the same published version; neither uses the working directory.
- Create feedback in source and rendered views: both threads are visible in both views and retain independent original targets.
- Locate a rendered Markdown-link comment while viewing source: switch to rendered view and highlight the original label without calculating Markdown line ranges.
- Locate a source comment from rendered view: return to its source view and native range.
- Toggle a view or publish while composing: the draft retains its original version and representation.
- Publish an HTML artifact with many supporting files: it opens the entrypoint with no file browser or companion-file viewer.
- Use linked documents, media, scripts, and data in HTML: all resolve from the selected version.
- Select rendered content in files or html: the same rendered locator and isolation rules apply.
- Open files or html: neither offers a diff view.
- Upgrade the Markdown renderer: older retained renderings and targets stay intact.
- Delete the publisher's directory: published versions remain readable.
- Post a reply about rendered version 1 with a source fix target in version 2 of a files artifact: each reference opens its declared view.
- Remove an element or change runtime state: the thread remains readable and unavailable placement is explicit.
- Publish a sparse diff with deleted lines: old-side targets validate without a full repository snapshot.
- Switch diff layout or expand captured context: target identity stays stable.
- Publish an independent second patch: r3 does not apply it to the first.
- Publish a correction: every earlier version remains visible and its original feedback and reply targets remain readable.
- Attempt individual version deletion: no such operation exists; whole-artifact deletion remains explicit.
- Interrupt or retry publication: no partial or duplicate version becomes visible.
- Race publishers, or race publication with archive: the transaction returns a clear conflict or ordered result.
- Archive with no message: listener unregisters without a push, and watch always exits with archived.
- Archive with a message: the existing listener receives that message, watch prints it and exits, and the event remains in history.
- Restore and archive again: earlier messages remain intact; retrying a transition does not create another event.
- Archive any kind: work stops without implying approval; Restore does not revive stale agent sessions.
- Run a rendered page with ES modules, a chart, and version-local JSON: normal interactivity works under the chosen isolation policy.
- Load version-local JSON by fetch and XHR, and seek within embedded published video: each request stays on the selected version.
- Try external resource loads, sockets, navigation, or unrelated same-host endpoints: the preview blocks them and reports the limitation.
- Use the camera or microphone: browser consent works in the isolated secure preview; denial is handled clearly and does not trigger an r3 approval dialog.
- Run two agents: publications and messages retain distinct attribution, independent feedback claims coexist, and publication races conflict cleanly.
- Use the HTML utility: the same thread appears in the panel and agent interface.
- Read and annotate a remotely published artifact with no checkout on the server: the workflow works.

## Confirmed decisions and remaining implementation work

| Area | Decision / remaining work |
| --- | --- |
| Source/rendered locate interaction | Initially switch to the original view for exact highlighting; no cross-view mapping requirement |
| Database and interface upgrade | Required database migration; design the new CLI/HTTP/UI freely without backward compatibility |
| Archive/Restore | Optional archive message; push only when supplied; watch always exits; retain lifecycle history |
| Version retention | Append-only visible history; no withdrawal or individual version deletion |
| Resources | Version-specific byte endpoint for fetch/XHR/modules/images/media; prove scoped preview authorization and media ranges |
| Network policy | No external requests; prove enforcement across supported browsers and request mechanisms |
| Device access | Browser-controlled consent; implement secure-origin permission delegation for camera/microphone |
| Preview isolation | Choose and prove the origin/access arrangement under the resource, device, and network constraints |
| HTML locator and text normalization | Rendered-native targets; source targets address published bytes independently |
| Utility method names and submit interaction | Same conversation and delivery model as the panel |
| URL authoring and routing | Relative/version-root resource URLs and hash routes first; automatic root rewriting/history fallback deferred |
| Legacy incomplete content and uncertain anchors | Keep product constraints strict; apply documented migration defaults and preserve original evidence |
| Agent collaboration scope | One user and multiple agents; persist session attribution now, defer assignment/fan-out; multi-user is a non-goal |
