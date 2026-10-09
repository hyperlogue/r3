The library is where you return to work after the first review. Search by content or conversation, filter the list, and open the exact publication or message that matches.

## Find something you remember

Search for a phrase from a proposal, a code identifier, or the words used in a discussion. Multiword queries match all words as prefixes. Queries support up to 16 words and 256 characters.

By default, content search uses the latest publication. Turn on **Include history** to search older versions. Conversation matches keep the version context recorded with the message.

```sh
r3 search "visibility explanation" --history all --json
```

HTML search uses the static entrypoint text, excluding scripts. It does not execute an interactive page to discover dynamic text. Binary files, invalid UTF-8, and text files over 4 MiB are excluded and counted in the search results’ coverage information.

## Narrow the list

Filter by active or archived state, artifact kind, or project. The attention filter helps find active work awaiting human review. Attention is distinct from an agent being registered or currently claiming a thread.

The CLI supports the same search scopes. Use `--type content` or `--type conversation`, `--project`, `--kind`, and `--attention` when you know where to look. `--limit` and `--offset` paginate results.

## Open the evidence

Content results open their matching publication and location. Conversation results identify the note or reply and its recorded context. A historical result should not silently open an unrelated location in the latest version.

Searching does not fetch pending feedback for handoff, acknowledge it, or claim work. You can investigate the library without changing delivery state.

## Keep the library useful

Give artifacts descriptive titles and group related work into [projects](/docs/projects/). Agents can use metadata for their own organization and filtering. Version summaries belong to individual publications rather than a mutable artifact overview.

Select several artifacts on the home page to archive or permanently delete them together. Use [usage and cleanup](/docs/cleanup/) to understand what remains stored before removing old work.
