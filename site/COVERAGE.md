# User-facing capability coverage

The website teaches the human review workflow with short task instructions and
visual examples. It is not an exhaustive protocol reference. Agent publication,
delivery, identity, and retry rules belong to `r3 guide`; exact command syntax
belongs to `r3 --help`. Those sources remain unchanged by website edits.

| Human task | Destination | Visual aid |
| --- | --- | --- |
| Install and begin a review | `/docs/`, `/docs/get-started/` | Actual prototype workspace |
| Understand the review loop | `/docs/review-loop/` | Publish → review → send → revise → check |
| Use a local or remote workspace | `/docs/access/` | Browser, workspace, and agent diagram |
| Try an interactive page | `/docs/html/` | Actual search explainer |
| Read documents and source | `/docs/files/` | File set and rendered document illustration |
| Review a patch | `/docs/diffs/` | Old/new code illustration |
| Discuss an image or video region | `/docs/media/` | Saved-frame illustration |
| Target, write, and send feedback | `/docs/feedback/` | Actual native highlight and floating thread |
| Inspect a fix and resolve | `/docs/revisions/` | Actual original/fix comparison |
| Arrange the workspace and review on a phone | `/docs/navigation/` | Actual mobile workspace |
| Learn a few keyboard shortcuts | `/docs/keyboard/` | Table from the product keymap; full map in app |
| Find content and conversations | `/docs/library/` | Search-result illustration |
| Group related reviews | `/docs/projects/` | Project and artifacts diagram |
| Archive, restore, inspect usage, or delete | `/docs/cleanup/` | Lifecycle diagram |
| Decide on preview and device permissions | `/docs/permissions/` | Default versus additional access diagram |
| Change common settings | `/docs/configuration/` | Short settings table |
| Recover from common problems | `/docs/troubleshooting/` | Symptom-based instructions |

The old agent/reference URLs remain as short pointers to built-in CLI help and
are outside the main documentation sidebar. Markdown exports, `llms.txt`, and
`llms-full.txt` preserve the human documentation and captions for other readers.
HTML illustrations are authored in `doc-visuals.ts`; screenshot generation and
integrity checks use the same pipeline as the homepage captures.

## Example Fieldwork stories

| Story | Text and layout | Interactive demo / recording |
| --- | --- | --- |
| Project-creation prototype | `/use-cases/prototype/` | Interactive workspace at `/example/index.html`; recording follows |
| Onboarding proposal | `/use-cases/proposal/` | Follow-up |
| Search explanation | `/use-cases/explanation/` | Follow-up |
| Duplicate-submission fix | `/use-cases/code-review/` | Follow-up |
| Launch media review | `/use-cases/media/` | Real image, video-frame, and comparison captures; sample scenes at `/example/index.html?scene=media` and `?scene=media-video` |

The public live demo remains available with its existing fixtures. The site labels
the homepage’s real workspace with fictional data and the demo’s scripted
behavior. Additional Example Fieldwork scenarios and recordings remain follow-up.

The homepage highlights element comments, direct agent handoff, fix comparisons,
image attachments, and video-frame comments. Each has a playable 10–12 second
film of the real interface, with animated focus, a poster, and a text transcript.
Fixtures are fictional and agent replies are scripted.
