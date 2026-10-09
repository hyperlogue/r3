# User-facing capability coverage

This map records where readers can discover each current capability. Paths are
public routes relative to the configured site mount. Command, guide, and keyboard
details come directly from their product sources during the build.

| Capability | Primary destination |
| --- | --- |
| Install, welcome, start/status/restart/stop, help | `/docs/get-started/` |
| Human review and agent publication loop | `/docs/review-loop/` |
| Interactive HTML, navigation, required entrypoint, stable targets | `/docs/html/`, `/docs/agents/html/` |
| Markdown, Mermaid fallback, highlighted source, rendered/source toggle | `/docs/files/` |
| Complete directories, downloads, subset and revision capture | `/docs/files/`, `/docs/agents/files/` |
| Unified/side-by-side diffs, sides, captured context, binary/rename metadata | `/docs/diffs/`, `/docs/agents/diff/` |
| Still images, audio, video, saved frames, regions, supported formats | `/docs/media/` |
| General, whole-file, rendered, source, diff, and media feedback | `/docs/feedback/` |
| Quotes, message images, crop/annotation, image limits, image-only messages | `/docs/feedback/`, `/docs/media/` |
| Draft persistence and view-independent targets | `/docs/feedback/`, `/docs/navigation/` |
| Send/Use in agent, pending edits, discussion fetch acknowledgment and retries | `/docs/feedback/`, `/docs/agents/` |
| Reply, edit/delete messages, resolve/reopen, Active/Resolved queues | `/docs/feedback/`, `/docs/revisions/` |
| Pinned versions, labels/summaries, Locate, fix targets, Compare | `/docs/revisions/` |
| Claims, expiry, comment delivery, listen/watch priority and exit codes | `/docs/agents/` |
| Local harness delivery, generic agents, backend notification subscriptions | `/docs/agents/`, `/docs/access/` |
| Content/conversation search, history, filters, exclusions, attention | `/docs/library/` |
| Titles and metadata | `/docs/library/`, `/docs/cli/` |
| Project creation/edit/deletion, remote inference, aliases | `/docs/projects/` |
| Archive/restore, lifecycle messages, subscription clearing | `/docs/cleanup/`, `/docs/revisions/` |
| Bulk actions, whole-artifact deletion, manual TTL cleanup | `/docs/cleanup/` |
| Usage totals, daily/weekly activity, timezone and retention semantics | `/docs/cleanup/` |
| Local server, remote URL, proxy configuration, login tokens and sessions | `/docs/access/`, `/docs/configuration/` |
| Backend selection, directory overrides, CLI login, API keys and audit | `/docs/access/`, `/docs/configuration/` |
| Notification worker lifecycle and connection status | `/docs/access/`, `/docs/troubleshooting/` |
| Single-owner permissions, token revocation and inactivity expiry | `/docs/access/` |
| Preview isolation, capability checks, compatibility consent, external grants | `/docs/permissions/` |
| Camera/microphone, browser permission, capture termination | `/docs/permissions/` |
| Passive Markdown cache, bounds, expiry and logout behavior | `/docs/permissions/`, `/docs/files/` |
| Dock modes, floating composer, file navigation, folding, viewed marks | `/docs/navigation/` |
| Mobile sheet, touch review, appearance and source themes | `/docs/navigation/` |
| Full current keyboard map | `/docs/keyboard/` |
| Full CLI command surface, inspection/downloads, discussion placement | `/docs/cli/` |
| Source-range retrieval, attachment download, native target JSON | `/docs/agents/`, `/docs/agents/files/`, `/docs/cli/` |
| Stable agent identity, distinct runs, display names | `/docs/agents/`, `/docs/configuration/` |
| Publication conflicts, idempotent retries, capture limitations | `/docs/agents/`, `/docs/troubleshooting/` |
| Migration prerequisite and common recovery paths | `/docs/troubleshooting/` |
| Agent-readable index, complete text, per-page Markdown | `/llms.txt`, `/llms-full.txt`, article `index.md` |

## Example Fieldwork stories

| Story | Text and layout | Interactive demo / recording |
| --- | --- | --- |
| Project-creation prototype | `/use-cases/prototype/` | Interactive workspace at `/example/index.html`; recording follows |
| Onboarding proposal | `/use-cases/proposal/` | Follow-up |
| Search explanation | `/use-cases/explanation/` | Follow-up |
| Duplicate-submission fix | `/use-cases/code-review/` | Follow-up |
| Launch media review | `/use-cases/media/` | Follow-up |

The public live demo remains available with its existing fixtures. The site labels
the homepage’s real workspace with fictional data and the demo’s scripted
behavior. Additional Example Fieldwork scenarios and recordings remain follow-up.
