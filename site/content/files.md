A files artifact is a complete directory of related work. It can contain a proposal, supporting notes, source code, images, and other assets. There is no required index file.

## Read in the useful representation

Markdown opens rendered. Other text opens as highlighted source. HTML and Markdown can switch between source and rendered views; media has native previews, and binary files can be downloaded.

Rendered Markdown supports formatted prose, code blocks, and supported Mermaid diagrams. Unsupported diagram syntax remains available as source. Raw HTML in published Markdown is escaped; for an authored HTML experience, ask the agent to publish an HTML page.

The file stack and file panel describe the same publication. Fold files to concentrate on one area, use **Jump to file** to move directly, or mark a file viewed to keep track of your review.

## Comment on prose or source

Select a passage in rendered view to discuss what the document says. Select source lines to discuss the file’s exact text. Whole-file feedback is useful for a missing section, an unclear purpose, or a concern that does not fit one line.

The representation matters: a comment on rendered text remains rendered evidence. Switching to source does not convert it into a guessed line number.

## Keep supporting files nearby

Ask for a complete set of files that explains the decision. In Example Fieldwork, the onboarding proposal might include `proposal.md`, `research-notes.md`, and an illustration. Use relative links between published files.

The agent can select a subset during capture, but that subset becomes the whole version. A later publication does not inherit omitted files from the previous one.

## Return to an earlier version

Use the version selector to read what was actually published before. Files versions are independent complete snapshots; r3 does not derive a diff between them. Ask for a [diff artifact](/docs/diffs/) when the change itself needs a line-by-line review.

Opened Markdown can use r3’s bounded browser reading cache after normal authentication. The passive reading view does not activate authored scripts or external resources. This improves repeat reading; it is not a promise of a fully offline workspace.

See the [onboarding proposal walkthrough](/use-cases/proposal/) for a review that combines prose and supporting evidence.
