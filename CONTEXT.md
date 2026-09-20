# r3 language

r3 presents published artifacts for people to read, use, and discuss with agents.
Feedback is optional; an artifact can be useful without a review conversation.

## Language

### Artifacts and publication

**Artifact**:
A continuing work product with its own identity, kind, versions, and conversations.
Its title and conversations can change while its published versions remain immutable.
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
Whether an artifact is active or archived; an archived artifact is set aside with
its versions and conversations retained, without implying approval or resolution.

**Review**:
The activity of examining and discussing an artifact, rather than a separate work
product or an approval state.

### Participants

**Human**:
The person using published artifacts and controlling whether feedback is resolved.

**Agent session**:
The identity of one logical agent run to which publications, messages, and claims
are attributed, including after that run ends.

**Publisher**:
The agent responsible for a particular publication; later versions may have
different publishers.
_Avoid_: Artifact owner.

### Conversations and locations

**Feedback**:
A conversation about an artifact, consisting of an opening message, replies, an
original target, and human-controlled resolution status.

**Reply**:
A message continuing a feedback conversation, optionally carrying message context
and a fix target.

**Feedback status**:
The human's classification of a conversation as open or resolved; resolved means
the conversation needs no further attention, whether or not content changed.

**Original target**:
The immutable subject of feedback when it was opened: the artifact as a whole, or
a page, file, or code change as it appeared in a specific version and view.

**Message context**:
The published version a reply is talking about and, when needed, the view used
for its references.
A reference such as `plan.md` points into that version, independently of any fix target.

**Fix target**:
A published location that a reply points to as its fix, potentially in a different
version or view from the message context or original target.

### Coordination and attention

**Claim**:
One agent session's temporary reservation to handle particular open feedback.
It coordinates responsibility without granting exclusive rights to publish or reply.

**Listener**:
The agent currently registered to receive an artifact's feedback notifications
or wait for pending feedback; an artifact has at most one listener at a time.
_Avoid_: Designated recipient.

**Handoff**:
The explicit passing of pending human messages and status changes to an agent,
including through a manually copied prompt.

**Unsent feedback**:
Human messages or status changes awaiting handoff to an agent.
_Avoid_: Unread.

**Unhandled feedback**:
Open feedback whose latest message is from an agent, indicating attention is due
from the human regardless of whether the message has been read.
_Avoid_: Unread.

### Project grouping

**Project**:
An optional group of artifacts with an identity that remains stable
when its repositories move or its display name changes.
_Avoid_: Repository.

**Repository remote**:
A network repository identity used by default to group new artifacts into the
same project when their publishers use the same repository.
Equivalent remote spellings share a group, configured mappings can group different
remotes together, and an explicit project choice overrides automatic grouping.
