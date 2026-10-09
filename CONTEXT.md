# r3 language

r3 presents published artifacts for people to read, use, and discuss with agents.
Feedback is optional; an artifact can be useful without a review conversation.

## Language

### Backends and access

**Backend**:
The r3 service selected for a body of work, owning its artifacts, conversations,
access grants, and notification routing. It may run locally or remotely.
_Avoid_: Project, daemon.

**Server**:
The process providing a backend's storage, API, and browser workspace.
_Avoid_: Worker, daemon when naming this role.

**Worker**:
The local service that receives backend wake notifications and delivers them to
agent harnesses. One worker can serve several backends.
_Avoid_: Server, proxy, daemon when naming this role.

**Client authorization**:
A revocable grant of access to one backend, represented by an API key or a
browser-approved OAuth grant. It is independent of agent authorship and presence.
_Avoid_: Agent session, browser session.

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

**Backend owner**:
The single human who controls a backend's access and artifact workspace.
_Avoid_: Publisher, claim owner, artifact owner.

**Agent session**:
The identity of one logical agent run to which publications, messages, and claims
remain attributed after the run ends. It grants no access and identifies neither a
live connection nor a notification destination.

**Publisher**:
The human or agent responsible for a particular publication; later versions may
have different publishers.
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
a page, file, media instant and region, or code change as it appeared in a specific
version and view. A media target retains the full saved frame as its visual evidence.

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

**Registration**:
An artifact's routing choice for a publisher fallback or explicit recipient.
A registration is distinct from the agent session it names and from whether it is
currently selected.
_Avoid_: Listener (for routing state), subscription (except in the wire format).

**Publisher fallback**:
The registration established by a publication to receive notifications when no
explicit registration is present.
_Avoid_: Fallback listener, artifact owner.

**Explicit registration**:
A registration established by listening or watching that takes precedence over
the publisher fallback.

**Selected recipient**:
The recipient currently chosen for an artifact through its explicit registration,
or through its publisher fallback when no explicit registration is present.
_Avoid_: Designated listener, owner.

**Notification destination**:
The local harness destination a worker uses to wake an agent, separate from the
agent session used for authorship. Its details remain private to the worker.
_Avoid_: Agent session, registration.

**Saved registration intent**:
A worker's retained intent to restore a registration when the backend permits it.
It does not establish live presence or entitlement to displace another recipient.
_Avoid_: Active listener, offline subscription.

**Watch**:
A CLI wait for pending feedback or archive that acts as an explicit registration
for the duration of the request.

**Wake notification**:
A prompt to an agent that feedback is ready to fetch, or that an artifact was
archived. Delivery or queue acceptance does not acknowledge feedback content.
_Avoid_: Handoff, feedback delivery.

**Handoff**:
The passing of a pending feedback snapshot to an agent, completed when its output
succeeds and the backend accepts acknowledgment of that snapshot. A wake
notification or copied command alone does not complete it.

**Unsent feedback**:
Human messages or status changes awaiting handoff to an agent.
_Avoid_: Unread.

**Unhandled feedback**:
Open feedback whose latest message is from an agent, indicating attention is due
from the human regardless of whether the message has been read.
_Avoid_: Unread.

### Project grouping

**Project**:
An optional group of artifacts within one backend, with an identity that remains
stable when its repositories move or its display name changes.
_Avoid_: Repository, backend.

**Project backend override**:
A working directory's setting that selects the backend for CLI operations.
It is independent of the Project groups stored by that backend.

**Repository remote**:
A network repository identity used by default to group new artifacts into the
same project when their publishers use the same repository.
Equivalent remote spellings share a group, configured mappings can group different
remotes together, and an explicit project choice overrides automatic grouping.
