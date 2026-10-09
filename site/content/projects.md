A project groups related artifacts. It does not own their files, determine agent identity, or create a separate permission boundary.

## Let Git grouping help

With remote grouping enabled, the publishing CLI detects a Git remote and sends a sanitized hint. The server can use that hint to associate the artifact with a project.

The CLI prefers the `origin` fetch URL, then `upstream`, then a sole remote. Ambiguous remotes stay ungrouped. Credentials are removed from the hint; project IDs are independent of checkout paths and URLs.

Later publications retain the artifact’s project. Publishing a revision from a different worktree does not silently move the artifact to another group.

## Choose a project explicitly

Create a project and tell the agent to use the returned ID when creating artifacts:

```sh
r3 project create --title 'Example Fieldwork'
r3 project list
```

An explicit `--project` on artifact creation takes priority over remote inference. Ask the agent to record the returned project ID in its working context rather than guessing an ID from the title.

## Manage titles and aliases

Projects have a title and optional remote metadata. Use `r3 project edit` to update those fields. Server-side `projectMappings` can map multiple remote URLs to an existing project; `projectGrouping` selects `remote` or `manual` behavior.

These settings take effect after restarting the server. See [Configuration](/docs/configuration/) for the complete setting list and [Command reference](/docs/cli/) for exact project commands.

## Remove a group

Deleting a project preserves its artifacts. This removes the grouping rather than deleting the published work or its conversations. Whole-artifact deletion is a separate action in [cleanup](/docs/cleanup/).
