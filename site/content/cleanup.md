Archive finished reviews to keep active work easier to find. Decide separately when the retained content should be permanently removed.

## Archive and restore

Archiving preserves versions, conversations, thread status, pending human content, and drafts. The artifact becomes read-only: publication, title and metadata changes, comments, and thread status changes require a restore. Archiving also clears claims and ends subscriptions.

You can include an archive comment explaining why the review is finished. It belongs to the artifact’s discussion and remains available in its history. A nonblank comment is also sent to the selected agent. Restore the artifact before editing that comment.

A failed notification does not undo the archive. The recorded lifecycle event is authoritative; retrying the same operation does not send a second notification.

Restore an artifact when it needs more work. Restore does not revive an old subscription: ask the agent to run `r3 listen <artifact-id>` or publish a new version.

## Inspect usage

Open usage information in the workspace or run:

```sh
r3 stat
r3 stat --weekly
```

Daily activity covers the last 14 calendar days; weekly activity covers four Monday-start weeks. Both include the current partial period and use the displayed server timezone. Add `--json` for structured output.

Activity counts survive artifact deletion. Older, pre-upgrade history covers surviving records only. Content size describes retained content bytes, excluding database and filesystem overhead.

## Preview a cleanup

Cleanup is manual. The default threshold is 30 elapsed days since the artifact’s most recent archive.

```sh
r3 gc --dry-run
```

Review the eligible artifacts before deleting them. Restore cancels eligibility. Archiving again starts a new countdown.

## Remove expired archives

```sh
r3 gc
```

This permanently removes eligible artifacts and conversations without a terminal prompt. The web Settings panel offers cleanup with a confirmation. Content shared by surviving publications is retained.

Use `--ttl 7d` to override the threshold for one run. Set the server default on its host machine with `r3 config set archiveTtlDays 30`, then run `r3 server restart`. The accepted range is 1 to 36,500 days.

## Delete selected work

You can permanently delete one artifact or select several in the library. Deletion removes the whole artifact and its history; individual versions cannot be deleted or edited. A project deletion, by contrast, preserves its artifacts.

The `gc` command reports failures with exit code 1. Review the result before assuming every eligible item was removed.
