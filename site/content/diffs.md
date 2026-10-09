A diff artifact shows one captured patch. It retains old and new sides, file names, renames, binary metadata, and the surrounding context captured at publication time.

## Pick a layout

Use unified view to read the change as one sequence, or side-by-side view to compare the old and new lines. Fold files you have finished, mark them viewed, and jump directly to another file when the patch is large.

Expand context where it was captured. r3 cannot fetch more lines from the agent’s live checkout. If the missing context affects your decision, ask the agent for a new publication with the needed evidence.

## Comment on the correct side

Select the relevant lines and explain the behavior you are questioning. A diff target records the file, version, side, and line range. The original target remains attached to those captured lines.

> This prevents a second click while the request is running, but what happens after a failed request? The button needs to become usable again.

The short quote shown in a thread may only be an excerpt. The complete selected range is retained; agents can retrieve it with `r3 discussions source`.

## Understand a new round

Each version is an independent patch. Do not read version 2 as an additional patch applied on top of version 1. The agent should publish the complete patch it wants reviewed in that round.

Open the reply’s line target or switch to the new version to inspect the fix. r3’s visual **Compare** applies to supported rendered and media targets; it does not invent a source or diff comparison from a general reply.

## Tell the agent what to capture

An agent can capture the working tree, staged changes, one commit, a revision range, or a supplied unified diff. Git capture happens on the publisher’s machine, so the r3 server does not need access to the repository.

Working-tree capture includes untracked files. Staged capture reads the index. Files from a named revision use a separate files-publication workflow. The exact flags are in [Publish diffs](/docs/agents/diff/).

Follow a concrete example in [Fix duplicate form submissions](/use-cases/code-review/).
