import { ArtifactCommandError } from "./artifact-args.ts";

export const ARTIFACT_HELP = `r3 — published artifacts and human/agent conversations

  create --kind files|html|diff <capture flags> [--title T] [--summary S]
  publish <id> <capture flags> [--expected <seq>] [--key <retry-key>]
  list [--state active|archived] [--kind K] [--project ID] [--meta k=v] [--mine]
  show <id> [--json]
  versions <id>
  files <id> --version <seq>
  source <id> --version <seq> --file <path>
  download <id> --version <seq> --file <path>   # original bytes to stdout
  patch <id> --version <seq>                  # original unified diff
  edit <id> [--title T] [--meta k=v]
  delete <id>                                # whole artifact and history

Capture: --dir <prepared-directory> [--file <relative-path>]...
         --ref <git-ref> --file <relative-path>...
         --stdin-diff | --working | --staged | --commit <sha> | --diff <base>..<head>
Publication summaries belong to versions. Artifacts have no overview field.
Publication: --version-label L --summary S --key K
             --label remains a publication-only alias; do not supply both spellings.
Create: --kind is required; --project ID --meta k=v (repeatable).
HTML images: publish standalone assets with relative <img src> URLs; see r3 guide html.

  feedback add <id> -m <message> [target flags]
  feedback edit <feedback-id> [-m <message>] [--status open|resolved --human]
  feedback delete <feedback-id>
  reply <feedback-id> -m <message> [--version <seq> --view source|rendered|diff]
        [--target <JSON fix target>]
  place <feedback-id> --target <JSON document target> --state anchored|unplaced|ambiguous
  claim <feedback-id>... | release <feedback-id>...
  feedback fetch <id> [--all] [--feedback <id,id>]
  prompt <id> [--all] [--feedback <id,id>]      # compatibility alias for feedback fetch
  watch <id> [--timeout <seconds>]
  listen <id>                                # local wake adapter, outward stream
  archive <id> [-m <archive-message>] [--key K] | restore <id> [--key K]
  project list | project create [--title T] [--remote URL] | project delete <id>
  project edit <id> [--title T] [--remote URL]

Targets: --target <JSON> or --file <path> --version <seq> --view source|rendered|diff
         [--line <start-end> --quote <text>] [--side old|new]
         rendered: --selector <CSS> [--quote <text>] [--route <query/hash>]
         HTML fix links: set locator.label in --target JSON (see r3 guide html).
         no target flags means general artifact feedback.
         Version descriptions are read-only metadata, not feedback targets.
Identity: --session <logical-agent-id> (or R3_AGENT_SESSION, then harness session).
          --human explicitly acts as the human owner. Distinct agents need distinct IDs.
Text flags accept - to read stdin. --json prints structured results.
Remote: R3_URL selects the application URL; R3_TOKEN supplies its API credential.

  auth create-token [--label L] | list-tokens | revoke-token <id> | revoke-token --all
  config show|get|set|unset ...
  start | stop | status | restart
  guide [html|files|diff]                     # workflow and optional preparation guides

Rendered previews automatically use the browser's r3 address (HTTPS or localhost).
Optional previewBaseUrl selects a separate endpoint; previewPort defaults to the
application port + 1 only for that override. Wildcard subdomains are unnecessary.
Configuration names:
bind, port, publicUrl, allowedHosts, requireLogin, previewPort, previewBaseUrl,
projectGrouping (remote|manual), projectMappings (JSON remote-URL to project-ID map).
Environment overrides: R3_PREVIEW_PORT, R3_PREVIEW_BASE_URL, R3_PROJECT_GROUPING.
Project settings take effect on the server after restart. An explicit project wins
over remote inference; project mappings can group aliases under an existing ID.
The CLI detects origin's fetch URL (then upstream or the sole remote), removes
credentials, and sends it for project grouping. Ambiguous remotes stay ungrouped.
Later versions retain their artifact's project; --project overrides creation.
`;

export const ARTIFACT_GUIDE = `# r3 — publish artifacts and respond to feedback

r3 lets agents publish immutable versions of artifacts for humans to review and optionally leave feedback. Run \`r3\` as a subprocess from your harness.

## A typical review

Prepare \`./prepared/plan.md\`. Use the returned artifact ID and the feedback IDs from the human's submission; the IDs below are examples.

\`\`\`sh
r3 create --kind files --dir ./prepared --title 'Design review'
artifact_id=artifact_example
# Share the printed URL, then register for notifications.
r3 listen "$artifact_id"

# When a feedback-submitted notification arrives:
r3 feedback fetch "$artifact_id"
r3 claim feedback_a feedback_b feedback_c

# Inspect the recorded targets and revise the prepared files.
r3 publish "$artifact_id" --dir ./prepared --expected 1
# Suppose publication returned version 2, discussed in rendered view:
r3 reply feedback_a --version 2 --view rendered -m 'Clarified ownership.' \\
  --target '{"kind":"rendered","versionSeq":2,"path":"plan.md","locator":{"selector":"#ownership"}}'
r3 reply feedback_b --version 2 --view rendered -m 'Added the missing case.'
r3 reply feedback_c --version 2 --view rendered -m 'Corrected the example.'
\`\`\`

The listener remains registered. If \`listen\` exits **5**, its harness wake adapter is unavailable; use \`r3 watch "$artifact_id"\`, which waits without that adapter. Exit **10** already includes fetched, acknowledged feedback on stdout: process it directly.

## Session and artifact kind

r3 normally infers identity from the harness environment. Optionally override it with \`R3_AGENT_SESSION\` or \`--session <id>\`. Each logical subagent needs a distinct ID.

Read this guide once per session. Specify \`--kind html|files|diff\` at creation; load each needed preparation guide once per session, when that kind is first needed:

| Kind | Review surface | Guide |
| --- | --- | --- |
| \`html\` | A rendered HTML page with optional assets such as images | \`r3 guide html\` |
| \`files\` | A directory with a file browser | \`r3 guide files\` |
| \`diff\` | An independent captured patch | \`r3 guide diff\` |

## Publish

\`r3 create --kind <kind> <capture flags> [--title T]\` publishes version 1. The preparation guide supplies capture flags. \`--kind\` is required; the kind stays fixed. Share the returned URL.

\`r3 publish <id> <capture flags> [--expected <seq>] [--key K]\` adds a version containing the complete file set or independent patch. Prepare builds before capture. \`--expected\` checks the latest published sequence, not which version you revised; if omitted, r3 reads the latest sequence. On conflict, inspect the newer publication. For a lost-response retry, preserve captured bytes, expected sequence, key, and metadata.

Optional \`--version-label\` names the published version; \`--summary\` describes it. The CLI detects the Git remote for server-configured project grouping. Explicit \`--project\` overrides inference; details and artifact metadata flags are in \`r3 --help\`.

## Receive feedback

\`r3 listen <id>\` checks and registers a background wake adapter. Supported adapters are Claude Code's messaging socket/token and Codex's thread/session environment plus a working \`codex queue --help\`. Exit 0 confirms registration; exit 5 requires watch or polling. A wake notification tells you to fetch feedback.

\`r3 watch <id> [--timeout <seconds>]\` works with any harness that can run the CLI with a stable identity. Exit 10 prints and acknowledges feedback; 0 means archived, 2 means timeout, and 4 means an occupied or superseded recipient slot. Handle expected nonzero exits explicitly, including under \`set -e\`. Treat other failures as errors. One designated listen/watch recipient exists per artifact.

\`r3 feedback fetch <id> [--all] [--feedback <id,id>]\` fetches and acknowledges the pending snapshot. \`--all\` reads open history without acknowledgment; add \`--feedback <id,id>\` to read specific threads, including resolved ones. \`r3 show <id>\` includes all open/resolved history. Use the existing payload when feedback was pasted or returned by watch.

## Handle feedback

\`r3 claim <feedback-id>...\` accepts multiple IDs, as shown above. Claims are renewable 60-minute leases; another live holder conflicts. Use \`r3 release <feedback-id>...\` when abandoning work. A resolved-status notification needs no action.

Inspect original targets in their recorded version and representation. Rendered selectors, quotes, routes, and viewports describe the published page, not source lines. Reuse matching local source when revising your own publication; retrieve published content only when needed, such as an older version or another agent's work. Inspection/download commands are in \`r3 --help\`.

Publish changed content, then \`r3 reply <feedback-id> -m <message>\`. Reply separately to each thread. Include \`--version <seq> --view source|rendered|diff\` when discussing a publication; omit both for general messages. Include \`--target\` whenever a published fix location can be verified. Supply JSON with \`kind\`, \`versionSeq\`, \`path\`, and \`locator\`, as above. Source locators use \`start\`, \`end\`, and exact \`quote\`; diff adds \`side\`; rendered uses a verified \`selector\` with optional quote/route. A null locator targets the whole file. The fix target has its own version/view, independent of message context. Omit it when no published location applies; never guess one. Original targets remain immutable; use \`place\` from \`r3 --help\` for additional verified placements.

Successful replies release only your own claims. Publishing and replying never resolve feedback; the human controls status. Complete the requested work, reply, and keep listening when requested. Archive ends the waiting loop and removes its listener; restore requires fresh registration.`;

const HTML_GUIDE = `# HTML artifacts

Read this once per session when HTML preparation is first needed; the main \`r3 guide\` covers publishing, listening, and replying.

An HTML artifact presents a rendered page with optional assets such as images. The publication root must contain \`index.html\`; the user enters through that page. Markdown documents belong in files artifacts, or may be linked as companion documents from an HTML page. Previously published Markdown entrypoints remain readable.

Use a shared navigation bar or tabs so every review page is reachable from every other page, directly or through several steps. Make the index a useful starting page and expose assets through the page's content or controls. The workspace intentionally has no file browser, source toggle, or companion-file viewer. Publishing a file alone does not make it discoverable. Use a files artifact when the human should browse the directory freely.

\`\`\`sh
r3 create --kind html --dir ./prototype --title 'Prototype'
r3 publish <id> --dir ./prototype --version-label 'Revised prototype'
\`\`\`

\`create\` requires \`--kind html\`; the unique root index selects the starting document automatically.

## Prepare the directory

Build dependencies before capture. Publish every referenced local asset on every version. An index-only \`--file\` filter omits companion assets.

Keep large images in standalone files and reference them with native HTML:

\`\`\`html
<img src="./assets/hero.webp" alt="Hero illustration">
\`\`\`

Extract large embedded base64/data-URL images into files, and reuse the same path where an image repeats. Relative URLs resolve from the document; a leading slash addresses the preview origin. The preview also supplies a version-root URL for constructed asset URLs. Use hash routes or published document paths for navigation.

## Preview and rendered feedback

Bundle dependencies and assets locally: external requests are blocked by default. If the page requires external services or device access, explain that requirement to the human.

Give important sections and controls unique, descriptive HTML IDs, such as \`id="pricing-comparison"\` or \`id="save-draft"\`. Keep each ID stable across revisions of the same element; avoid random IDs or IDs based on list position, and do not reuse an ID for an unrelated element. Stable IDs make rendered feedback easier to anchor and inspect.

For a new rendered target, \`feedback add\` accepts \`--file <path> --version <seq> --view rendered --selector <CSS>\` with optional \`--quote <text>\` and \`--route <query/hash>\`, or a complete \`--target <JSON>\` document target. Target the recorded page and route. The main guide explains original evidence, later placements, and reply/fix context.

When replying with a fix, choose a short, meaningful \`locator.label\` and pin it to a verified element using \`locator.selector\`. The HTML workspace displays **Fix: Storage help button**, rather than a filename. The label is plain text (1–200 characters) and names the location; only the selector and optional quote/route locate it. Keep \`path\` and \`versionSeq\` in the target to identify the published document. Verify the selector identifies exactly one visible element on that page and route. Existing unlabeled targets display **Page element**, or **Page** for a null locator.

\`\`\`sh
r3 reply <feedback-id> -m 'Added the storage explanation.' --version 2 --view rendered \\
  --target '{"kind":"rendered","versionSeq":2,"path":"index.html","locator":{"selector":"#storage-help","label":"Storage help button"}}'
\`\`\``;

const FILES_GUIDE = `# Files artifacts

Read this once per session when files preparation is first needed; the main \`r3 guide\` covers publishing, listening, and replying.

A files artifact is a nonempty complete file set with no index requirement. The browser shows all files as a foldable stack with a matching file panel. Markdown opens rendered; other text opens as source. HTML/Markdown can switch between source and rendered views. Media has native previews; binary files can be downloaded. Files artifacts do not derive diffs between versions.

## Capture

\`\`\`sh
r3 create --kind files --dir ./prepared --title 'Design documents'
r3 publish <id> --dir ./prepared
\`\`\`

Use \`--kind files\` explicitly at creation, including for directories containing an index. To publish a subset, repeat \`--file <relative-path>\`; a selected directory includes its descendants. The resulting selection is the complete version, not an update to the prior version.

For committed Git files, combine a valid \`--ref <git-ref>\` with repeated \`--file\` selections. Without a ref, use directory capture for the current files:

\`\`\`sh
r3 create --kind files --ref HEAD --file docs/plan.md --file src
r3 publish <id> --dir . --file docs/plan.md --file src
\`\`\`

\`--ref\` has no special \`STAGED\` value. Directory capture reads working-tree bytes, including any unstaged changes; it does not promise an exact index snapshot.

Directory capture includes hidden files. Prepare the intended publication directory or select explicit relative paths. Materialize symlinks into ordinary files before capture; symlinks and special files are rejected. Publish stable content: capture fails if files or membership change during the read.

## Source and rendered feedback

For a new source target, \`feedback add\` accepts \`--file <path> --version <seq> --view source --line <start-end> --quote <captured text>\`. Omit line and quote for a whole-file target.

For rendered HTML/Markdown, use \`--view rendered\` with \`--selector <CSS>\` and optional \`--quote <text>\` and \`--route <query/hash>\`, or the recorded JSON target. Keep any companion assets in the publication and use relative document URLs. Rendered previews remain isolated; files artifacts do not receive the HTML-artifact external-access grant.

The main guide covers the feedback loop and native evidence. Use \`r3 --help\` for inspection and placement command details.`;

const DIFF_GUIDE = `# Diff artifacts

Read this once per session when diff preparation is first needed; the main \`r3 guide\` covers publishing, listening, and replying.

Each diff version is an independent immutable sparse patch. It retains old/new sides, rename and binary metadata, and captured context. Versions are not patches to apply successively, and r3 does not reconstruct a full tree or retrieve uncaptured context from the publisher.

## Capture

Choose one capture mode for each publication:

| Flag | Captured changes |
| --- | --- |
| \`--working\` | Working tree against HEAD, including untracked files |
| \`--staged\` | Index against HEAD |
| \`--commit <sha>\` | One commit against its first parent, or the empty tree for a root commit |
| \`--diff <base>..<head>\` | The difference between two Git revisions |
| \`--stdin-diff\` | A supplied unified diff from stdin |

\`\`\`sh
r3 create --kind diff --working --title 'Navigation changes'
r3 publish <id> --staged
git diff main feature | r3 publish <id> --stdin-diff
\`\`\`

Git capture runs on the publisher. The daemon stores the captured patch and context. A later publication should express the complete intended review against its chosen base. The stdin path carries the supplied patch; context outside that input is unavailable.

## Diff targets

Read the captured patch with \`r3 patch <id> --version <seq>\`. For a new line target, \`feedback add\` accepts \`--file <path> --version <seq> --view diff --side old|new --line <start-end> --quote <captured text>\`.

The side distinguishes removed and added content. Line numbers and quote text must match the selected captured side. Omit side, line, and quote for a whole-file diff target. Use the main guide for original evidence, additional placements, and replying with explicit version/diff context.`;

export function artifactGuide(args: string[]): string {
  if (args.length > 1)
    throw new ArtifactCommandError("guide expects at most one topic: html, files, or diff");
  switch (args[0]) {
    case undefined:
      return ARTIFACT_GUIDE;
    case "html":
      return HTML_GUIDE;
    case "files":
      return FILES_GUIDE;
    case "diff":
      return DIFF_GUIDE;
    default:
      throw new ArtifactCommandError(
        "Unknown guide topic. Choose html, files, or diff, or run r3 guide for the workflow.",
      );
  }
}
