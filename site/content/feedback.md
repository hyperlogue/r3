A useful comment combines a precise target with a clear request. r3 keeps both alongside the original publication so your agent has something concrete to act on.

The **Discussion** panel gathers the conversation around an artifact. Each concern
has its own **thread**, made up of **comments**. Reply within a thread to continue
the same topic, and resolve the thread when it no longer needs attention.

## Choose a target

| What you are reviewing | Useful target |
| --- | --- |
| An interactive page | A rendered element or selected text, with its page and route. |
| A document | A rendered passage, source lines, or the whole file. |
| A patch | Old or new lines in the captured diff. |
| An image or video | A saved frame and, optionally, a region. |
| The overall work | A general comment about the artifact. |

Use comment mode for rendered elements. A source or diff selection keeps its native line information. Rendered evidence is never reverse-mapped into source lines.

## Say what should change

Name the problem, explain why it matters, and describe an observable result.

> “Workspace” does not tell me who can see this. Add a short explanation before the Create project button so I can choose without guessing.

You can also ask questions. “Why is this search result ranked first?” gives the agent a specific concept to explain.

## Quotes, images, and drafts

When the composer is empty, an anchoring gesture starts a note. When it already contains text, r3 offers a quote action so you can add evidence without losing your draft.

Paste or attach images when a visual explanation helps. Image references are numbered within each message. Your agent must download and open the images to inspect their contents; a textual attachment reference does not load the pixels into its context.

In supported browsers, **Capture area** lets you share the current tab and capture the preview, then crop or draw on the image before attaching it. This adds visual evidence to your comment; it does not turn the screenshot into a source-line or element target. You can also paste a screenshot from another tool.

Drafts retain their target and version as you switch views. They persist after a short debounce. Give the save a moment before closing the page, and heed any warning that an image is only available in memory.

## Send when you are ready

Add several comments and then use **Send to agent**. The active recipient is notified and fetches the pending batch. A queued notification may wait until the agent’s session resumes.

Without an agent subscription, choose **Use in agent** and run the copied `r3 comment fetch` command in your harness. The browser does not acknowledge comments simply because you copied the command.

The fetch command acknowledges only after successfully writing the snapshot to stdout. A failed read or output leaves the comments pending. A conflicting edit or failed acknowledgment can mean repeated output on retry; it does not discard the newer edit.

## Continue the conversation

Reply in the same thread when you are discussing the same concern. The thread menu lets you edit your latest comment while it is the last message; after an agent replies, add a new comment instead. **Delete** removes the whole thread and its comments.

Editing an open human comment makes the updated content pending again. Editing a resolved thread does not reopen it automatically. Archived artifacts must be restored before any of these changes.

The human controls open/resolved status. Agent claims indicate work in progress, not resolution. Use [Revisions & resolution](/docs/revisions/) to finish the loop.
