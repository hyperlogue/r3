# Artifact design

r3's implemented model is **Artifact → Version → Content**, with feedback and
replies attached to the artifact. Reviewing is an activity on that work product.
This document explains the product boundaries and the reasons behind them.

Use [the schema reference](schema.md) for storage constraints and migration,
[verification](verification.md) for acceptance checks, and the
[API reference](../../.claude/skills/api-surface/SKILL.md) for routes and commands.
The public wire types live in [shared/artifacts.ts](../../shared/artifacts.ts).

## Three kinds, one publication model

| Kind | Published content | Workspace |
| --- | --- | --- |
| `files` | A complete directory with at least one file | All files in one scrolling pane with foldable headers and a synchronized file browser; text opens as source, with per-file rendered HTML/Markdown, media previews, and downloads |
| `html` | A complete directory with a root `index.html` or `index.md` | Rendered entrypoint and feedback panel; no file browser or source toggle |
| `diff` | An independent unified patch | Captured old/new lines, split or unified layout, and expandable retained context |

Kind stays fixed for an artifact. Directory capture defaults to `files`; an index
file does not implicitly change its kind. An HTML version selects its entrypoint:
a unique supported index is inferred, and two indexes require an explicit choice.
Individual zero-byte files are valid; empty directory publications are rejected.

Files and HTML share file storage, retained rendering, and resource serving. HTML
specializes the workspace: the entrypoint and its linked pages determine how the
reader encounters supporting files. The CLI/API can still retrieve those files.
Neither directory kind offers a diff view.

A diff keeps its sparse patch payload. Removed lines, hunk gaps, rename metadata,
and binary markers cannot be represented by a fabricated complete directory.
Publication order does not imply patch application: version 2 need not apply on
top of version 1. Diff rendering produces HTML for display while retaining native
old/new target semantics.

All kinds share version identity, conversations, claims, owner handoff, and
active/archived lifecycle. Files and HTML own their members directly; there is no
additional directory-container entity for a caller to create or manage.

Artifacts have a title and metadata, with no overview field or overview panel.
Optional summaries belong to immutable versions. Retired overview text and comment
targets remain historical evidence when an older store is upgraded.

## Publication and content ownership

The publisher captures local input and sends complete bytes. The daemon owns the
published content; ordinary reads never resolve a checkout, worktree, or publisher
path. Projects are optional explicit groups, independent of filesystem location
and remote URL. A publisher can go offline or delete its directory without making
stored versions unreadable.

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

## Resources and page authoring

The application API separates membership from original bytes:

```text
GET      /api/artifacts/:id/versions/:seq/files
GET/HEAD /api/artifacts/:id/versions/:seq/resource?path=<encoded-relative-path>
```

The first returns the file list as JSON. The second returns original bytes with
media type, validators, private caching, and byte-range support. Application-origin
downloads are attachments. Executable content belongs to the separate preview host.

A preview context binds one artifact/version to a temporary isolated origin. Its
`/files/<path>` resources use that same version's content; `/r3/` serves trusted
preview support. Native modules, CSS, images, audio/video, fetch, and XHR authenticate
with a scoped preview cookie. The page receives no application credential.
Unknown paths return 404, with no other-version, filesystem, or proxy fallback.

Author pages with relative URLs, hash routes, and published document paths:

```html
<img src="./images/plot.png">
<video controls src="./media/demo.webm"></video>
<script type="module">
  const data = await fetch('./data/chart.json').then(response => response.json());
</script>
```

Those requests stay on the displayed version after a newer publication arrives.
Nested documents use normal directory-relative resolution. The utility exposes a
`resourceRoot` for constructing URLs from the version root. A leading `/` addresses
the preview origin root, not that resource root; arbitrary root-relative rewriting
and SPA history-route fallback are unsupported. A missing asset remains distinct
from a client-side route.

## Reading, selecting, and locating

The browser pins the displayed version. A new publication is announced with an
**Open latest** action; it does not replace the content being read. Version switches
and representation toggles preserve a draft's original target and message context.
Artifact links can include `version`, `file`, `view`, and `feedback` query parameters.

Rendered comment mode intercepts element picks before page handlers and supports
selecting a parent element. Normal mode preserves page interaction. Source and
diff selections use their own range gestures. Each creates a native target:

| Target | Evidence | Locate behavior |
| --- | --- | --- |
| Source | Published path, version, source range and quote | Open that source view and range |
| Rendered | Published document/version, selector, optional text/context, route and viewport | Open that rendered document and locate its element/text |
| Diff | Patch version, path, old/new side, captured range and quote | Open that patch and native side, hydrating or expanding retained context as needed |

Artifact-wide notes, artifact/version summaries, and whole-document/file targets
are explicit variants. Absence of version context never secretly means latest.

Feedback's original target is immutable. Additional **placements** record a target
and `anchored|ambiguous|unplaced` result for a version, path, and representation.
They do not replace the original or duplicate the conversation. Source and rendered
placements for the same file/version can coexist.

Rendered Markdown feedback addresses visible content directly. For example, a note
on a link label does not need a computed Markdown source range. Its thread appears
in both views, and Locate returns to the rendered view where it began. Source notes
work symmetrically. Exact cross-representation matching is not required.

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
credentials. Any harness can use watch or prompt without an automatic wake adapter.

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

Files and HTML use the same isolated rendering module. Ordinary scripts, modules,
styles, canvas/SVG charts, local forms, and published data run inside it. Source
views display escaped input without executing it.

The network is closed to the selected version's resources and trusted r3 preview
support. External APIs, CDNs, fonts/images/media, sockets, unrelated same-host
endpoints, redirects, and networked WebRTC are blocked. Pages must publish their
assets and dependencies. The preview is not an upstream proxy.

The server combines a distinct origin, scoped authentication, CSP/sandbox policy,
and Connection Allowlists. Before loading executable content, a capability gate
verifies URL blocking and WebRTC rejection. Unsupported browsers fail closed.
Camera/microphone retain browser consent through the secure preview's permission
delegation; permission neither opens networking nor automatically publishes capture.
The [security reference](../../.claude/skills/security-model/SKILL.md#preview-host)
owns enforcement details; [verification](verification.md) owns browser evidence.

Pages may import `/r3/utility.js` to use the narrow
[ArtifactUtility interface](../../shared/preview-protocol.ts): context, threads,
feedback creation, replies, explicit Submit, and change subscriptions. These use
the same conversations and handoff as the built-in panel. Human mutations require
user activation. The bridge validates its source, origin, context, and document
scope; it exposes no generic API, actor override, publication, lifecycle, or host
execution capability. Pages work without importing it.

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
