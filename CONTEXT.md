# r3 language

r3 presents published artifacts for people to read, use, and discuss with agents.
Discussion is optional; an artifact can be useful without a review conversation.

## Language

### Backends and access

**Backend**:
The entity that owns artifacts, conversations, access grants, and notification
routing under its own access policy.
_Avoid_: Project, daemon.

**Server**:
The process providing a backend's storage and browser workspace, running on the
same machine as the CLI or on another machine.
_Avoid_: Notification worker, daemon when naming this role.

**Notification worker**:
The service on an agent's machine that delivers comment notifications from
backends to local agent harnesses. One notification worker can serve several backends.
_Avoid_: Server, proxy, daemon when naming this role.

**Client authorization**:
A revocable grant of access to one backend, represented by an API key or a
browser-approved OAuth grant. It is independent of agent authorship and presence.
_Avoid_: Agent session, browser session.

### Artifacts and publication

**Artifact**:
A continuing work product with its own identity, kind, versions, and conversations.
While active, its title and conversations can change; its published versions remain
immutable.
_Avoid_: Review (for the artifact itself).

**Version**:
An immutable edition of an artifact, containing its complete published file set or
an independent captured patch, together with its publication metadata.

**Publication**:
The act of making a complete version available under an artifact's identity.

**Artifact kind**:
The artifact's fixed category: HTML, files, or diff.

**HTML artifact**:
An artifact presented as a rendered page, with its linked pages and supporting
assets.

**Files artifact**:
An artifact whose versions contain complete file collections that the reader can
browse freely, including documents, code, and media.

**Diff artifact**:
An artifact whose versions each contain an independent set of captured changes,
with old and new sides and available surrounding context.
_Avoid_: Difference between artifact versions.

**Selected version**:
The version a reader has chosen to view, which may differ from the latest version.
_Avoid_: Current version.

**Latest version**:
The most recently published version of an artifact.
_Avoid_: Current version.

**Artifact state**:
Whether an artifact is active for ongoing work or archived for reference.
An archived artifact retains its versions and conversations, with further
publication, conversation changes, metadata edits, and subscriptions closed until restore.

**Review**:
The activity of examining and discussing an artifact, rather than a separate work
product or an approval state.

### Participants

**User**:
A person who uses published artifacts and participates in discussions under the
backend's access policy. The bundled r3 backend serves one user; other backends may
serve several without changing how clients authorize access.
_Avoid_: Backend owner, artifact owner.

**Agent session**:
The identity of one logical agent run, distinguished from runs in other harnesses,
to which publications, messages, and claims remain attributed after the run ends.
It grants no access and identifies neither a live connection nor a notification destination.

**Publisher**:
The agent responsible for a particular publication, or the user when publishing
directly. Later versions may have different publishers.
_Avoid_: Artifact owner.

### Conversations and locations

**Discussion**:
A conversation about an artifact, with an opening comment, subsequent comments, an
immutable original target, and user-controlled resolution status.
_Avoid_: Feedback (for the conversation), comment (for the whole conversation).

**Comment**:
An authored message belonging to a discussion or directly to an artifact. It may
point to a published location. A reply continues a discussion; an archive comment
stands in the artifact history without its own resolution status.
_Avoid_: Feedback (for a message), reply (as a separate message entity).

**Discussion status**:
The user's classification of a discussion as open or resolved; resolved means
the discussion needs no further attention, whether or not content changed.

**Original target**:
The immutable subject of a discussion when it was opened: the artifact as a whole,
or a page, file, media instant and region, or code change in a specific version and
view. A media target retains the full saved frame as its visual evidence.

**Fix target**:
A published location that a comment points to as its fix, potentially in a different
version or view from the discussion's original target.

### Coordination and attention

**Claim**:
One agent session's temporary reservation to handle a particular open discussion.
It coordinates responsibility without granting exclusive rights to publish or comment.

**Subscription**:
An agent's arrangement to receive notifications about an artifact, either as its
publisher fallback or by explicitly subscribing. It is separate from the agent's
identity and may remain unselected while another subscription takes priority.
A notification worker losing its connection does not end its subscription.
_Avoid_: Registration, listener (for the subscription itself).

**Publisher fallback**:
The subscription established by a publication to receive notifications when no
explicit subscription is present.
_Avoid_: Fallback listener, artifact owner.

**Explicit subscription**:
A subscription established by listening or watching that takes precedence over
the publisher fallback.

**Selected subscription**:
The subscription currently chosen to receive an artifact's notifications: its
explicit subscription when present, otherwise its publisher fallback.
_Avoid_: Selected recipient, designated listener, owner.

**Notification destination**:
The local harness destination a notification worker uses to reach an agent,
separate from the agent session used for authorship.
_Avoid_: Agent session, subscription.

**Watch**:
A wait for pending comments or archive, with an explicit subscription for its
duration.

**Comment notification**:
A message prompting an agent to collect pending comments or discussion status
changes, or carrying an artifact's archive comment. A signal alone does not
confirm delivery of the comments it announces.
_Avoid_: Wake notification, artifact notification, comment delivery.

**Comment delivery**:
The confirmed transfer of pending user comments and discussion status changes to
an agent. A notification carrying a complete archive comment can also deliver it;
a notification that only prompts collection does not.
_Avoid_: Handoff, feedback delivery, notification delivery.

**Unsent comments**:
User comments or discussion status changes awaiting delivery to an agent.
_Avoid_: Unread, unsent feedback.

**Unhandled discussion**:
An open discussion whose latest comment is from an agent, indicating attention is
due from the user regardless of whether the comment has been read.
_Avoid_: Unread, unhandled feedback.

### Project grouping

**Project**:
An optional group of artifacts within one backend, with an identity that remains
stable when its repositories move or its display name changes.
_Avoid_: Repository, backend.

**Directory backend override**:
A working directory's setting that selects the backend for CLI operations.
It is independent of the Project groups stored by that backend.

**Repository remote**:
A network repository identity used by default to group new artifacts into the
same project when their publishers use the same repository.
Equivalent remote spellings share a group, configured mappings can group different
remotes together, and an explicit project choice overrides automatic grouping.
