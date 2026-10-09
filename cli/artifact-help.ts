import { styleText } from "node:util";
import { R3_VERSION } from "../shared/version.ts";
import { ArtifactCommandError } from "./artifact-args.ts";

export function artifactWelcome(): string {
  return `
  ${styleText(["bold", "cyan"], "r3")}  Render. Review. Refine.  ${styleText("dim", `v${R3_VERSION}`)}

  Review files, pages, and code changes with your agent.

  ${styleText("cyan", "r3 start")}     Start the workspace and show its URL
  ${styleText("cyan", "r3 status")}    Show workspace status and URL
  ${styleText("cyan", "r3 list")}      List your artifacts
  ${styleText("cyan", "r3 --help")}    All commands and options

  ${styleText("bold", "Agents:")} run ${styleText("cyan", "r3 guide")} before publishing or handling feedback.
`;
}

export const ARTIFACT_HELP = `r3 — published artifacts and human/agent conversations

Run r3 for a quick start. Agents: start with r3 guide.

  create --kind files|html|diff <capture flags> [--title T] [--summary S]
  publish <id> <capture flags> [--expected <seq>] [--key <retry-key>]
  list [--state active|archived] [--kind K] [--project ID] [--meta k=v] [--mine]
  search <query> [--state active|archived] [--kind K] [--project ID]
        [--attention] [--history latest|all] [--type all|content|conversation]
        [--limit 1..100] [--offset N] [--json]
  show <id> [--json]
  versions <id>
  files <id> --version <seq>
  source <id> --version <seq> --file <path>
  download <id> --version <seq> --file <path>   # original bytes to stdout
  patch <id> --version <seq>                  # original unified diff
  edit <id> [--title T] [--meta k=v]
  delete <id>                                # whole artifact and history
  stat [--weekly] [--json]                    # current totals and activity
  gc [--dry-run] [--ttl 30d] [--json]          # permanently remove expired archives

Statistics: daily activity for the last 14 calendar days; --weekly selects the last
            4 Monday-start weeks. Uses the displayed server timezone and includes
            the current partial period. Activity counts survive artifact deletion;
            pre-upgrade history covers surviving records only.
Cleanup: manual only. Default TTL is 30 elapsed days since the latest archive.
         --dry-run previews without deleting. gc deletes without prompting, keeps
         shared content still in use, and reports failures (exit 1; success 0).
         --ttl accepts 1d..36500d and overrides the server default for one run.
         r3 config set archiveTtlDays 30 persists that default; restart to apply.
         This edits the local config, even when R3_URL selects a remote backend.
         Restore cancels eligibility; archiving again starts a new countdown.
         Content size excludes database/filesystem overhead.

Capture: --dir <prepared-directory> [--file <relative-path>]...
         --ref <git-ref> --file <relative-path>...
         --stdin-diff | --working | --staged | --commit <sha> | --diff <base>..<head>
Diff text requires UTF-8. Git capture always includes changed submodule pointers.
Publication summaries belong to versions. Artifacts have no overview field.
Search: quote multiword queries; all words match as prefixes (up to 16 words / 256 characters).
        Latest content by default; conversations retain their recorded version context.
        HTML searches static entrypoint text without scripts. Text files over 4 MiB,
        binary files, and invalid UTF-8 are excluded and counted. No delivery acknowledgment.
Publication: --version-label L --summary S --key K --no-listen
             --label remains a publication-only alias; do not supply both spellings.
Create: --kind is required; --project ID --meta k=v (repeatable).
HTML images: publish standalone assets with relative <img src> URLs; see r3 guide html.

  feedback add <id> [-m <message>] [--attach <image>]... [--key K] [target flags]
  feedback edit <feedback-id> [-m <message>] [--status open|resolved --human]
        [--attach <image>]... | [--clear-attachments]
  feedback delete <feedback-id>
  reply <feedback-id> [-m <message>] [--attach <image>]... [--key K]
        [target flags] [--frame <snapshot.png>]
  place <feedback-id> --target <JSON document target> --state anchored|unplaced|ambiguous
  claim <feedback-id>... | release <feedback-id>...
  feedback fetch <id> [--all] [--feedback <id,id>] [--attachments-dir <directory>]
  feedback image <id> --image <image-id> [--output <file>] # bytes to stdout otherwise
  feedback source <feedback-id> [--json]      # full captured source/diff range
  watch <id> [--timeout <seconds>]
  listen <id>                                # explicit notification recipient
  unlisten <id>                              # remove your listener registrations
  archive <id> [-m <archive-message>] [--key K] | restore <id> [--key K]
  project list | project create [--title T] [--remote URL] | project delete <id>
  project edit <id> [--title T] [--remote URL]

Targets: --target <JSON> or --file <path> --version <seq> --view source|rendered|diff
         [--line <start-end> --quote <text>] [--side old|new]
         source/diff quotes may be exact excerpts within the complete line range.
         rendered: --selector <CSS> [--quote <text>] [--route <query/hash>]
         Media: --target JSON with kind media, versionSeq, path, locator {time, box},
         plus --frame <snapshot.png|jpg>. time is seconds (null for images); box is
         normalized {x,y,width,height}, default full frame. Snapshots stay immutable.
         HTML fix links: set locator.label in --target JSON (see r3 guide html).
         no target flags means general artifact feedback.
         Version descriptions are read-only metadata, not feedback targets.
Identity: R3_AGENT_SESSION overrides the harness identity for agent writes.
          --session <name> sets a readable display name; it never changes identity.
          --human acts as the human owner. watch needs no supplied identity.
Feedback fetch writes new feedback/replies to stdout, acknowledges that snapshot
only after output succeeds, then registers the calling agent when supported.
Listener failure only warns on stderr. A failed acknowledgment can repeat output
on retry; concurrent edits remain pending. --human skips listener registration.
Use ! r3 feedback fetch <id> in your harness to load feedback into its context.
--all reads history without acknowledgment or listener registration.
Images: static PNG/JPEG, at most four per message, 5 MiB and 20 megapixels each.
A message needs text or an image. Editing with --attach replaces all images;
omitting it preserves them. --clear-attachments removes them (text must remain).
Use the same --key to retry an unchanged add/reply after an uncertain response.
Image references are numbered [image1], [image2], etc. within each message in
fetch output. --attachments-dir downloads and
verifies the snapshot's images before output and acknowledgment; failures leave
feedback pending. Existing matching files are reused; different files are not overwritten.
Text flags accept - to read stdin. --json prints structured results.
Backend: R3_URL > nearest project .r3.json backendUrl > user backendUrl > local.
Use r3 login for browser approval, or pipe an API key to r3 login --api-key-stdin.
Credentials are saved privately per backend; R3_TOKEN is not a client override.

  login [--api-key-stdin]
  auth create-key [--label L] [--expires-days N] | list-clients | revoke-client <id> | audit
  auth create-token [--label L] | list-tokens | revoke-token <id> | revoke-token --all
  config show|get|set|unset ...
  server start|stop|status|restart            # local storage and browser server
  worker start|stop|status|restart            # local notification delivery
  start | stop | status | restart            # aliases for server lifecycle
  guide [html|files|diff]                     # workflow and optional preparation guides

Rendered previews automatically use the browser's r3 address (HTTPS or localhost).
Configuration names:
backendUrl, bind, port, publicUrl, allowedHosts, requireLogin, authTokenIdleDays,
trustedProxies (comma-separated immediate proxy IP addresses),
archiveTtlDays (1..36500; default 30),
projectGrouping (remote|manual), projectMappings (JSON remote-URL to project-ID map).
Login tokens expire after authTokenIdleDays of inactivity (default 14, positive
integer). Successful login or cookie authentication refreshes last use; unused
tokens age from creation. Inactivity is calculated when authenticating; startup
removes inactive or revoked rows.
Cookie-use timestamps are saved once per minute and at graceful shutdown.
Environment overrides: R3_AUTH_TOKEN_IDLE_DAYS, R3_PROJECT_GROUPING.
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
# Share the printed URL. Local Claude Code/Codex publications register automatically.

# When a feedback-submitted notification arrives:
r3 feedback fetch "$artifact_id"
r3 claim feedback_a feedback_b feedback_c

# Inspect the recorded targets and revise the prepared files.
r3 publish "$artifact_id" --dir ./prepared --expected 1
# Suppose publication returned version 2, discussed in rendered view:
r3 reply feedback_a -m 'Clarified ownership.' \\
  --target '{"kind":"rendered","versionSeq":2,"path":"plan.md","locator":{"selector":"#ownership"}}'
r3 reply feedback_b -m 'Added the missing case.'
r3 reply feedback_c -m 'Corrected the example.'
\`\`\`

The backend keeps subscriptions across a temporary disconnect and displays delivery errors in the browser. The persistent worker reconnects without changing selection or submitting feedback. A fresh \`r3 listen\` from the same or another agent replaces the explicit subscription. If \`listen\` exits **5**, its harness wake adapter is unavailable; use \`r3 watch "$artifact_id"\`, which waits without that adapter. Exit **10** already includes fetched, acknowledged feedback on stdout: process it directly.

Archived artifacts remain readable. Content changes, comments, and subscriptions return a conflict until you restore the artifact. A reply still in preparation when archive commits is rejected; keep its text and restore before retrying.

## Usage and cleanup

Use \`r3 stat\` for current library totals and daily activity over 14 days, or
\`r3 stat --weekly\` for four weeks. Both support \`--json\` and use the server timezone.
Activity counts remain after deletion; pre-upgrade history is partial.
\`r3 gc --dry-run\` previews archived artifacts past the TTL. \`r3 gc\` permanently removes
them and their conversations without prompting. The default is 30 days since archive;
\`--ttl 7d\` overrides one run. \`r3 config set archiveTtlDays 30\` changes the local
server default after restart. Cleanup is manual; restore cancels eligibility.

## Session and artifact kind

r3 infers identity from the harness environment. Generic writing agents and subagents can supply a distinct, stable \`R3_AGENT_SESSION\`. Use \`--session <name>\` for a readable display name; names do not change identity. A generic \`watch\` needs no supplied ID.

Read this guide once per session. Specify \`--kind html|files|diff\` at creation; load each needed preparation guide once per session, when that kind is first needed:

| Kind | Review surface | Guide |
| --- | --- | --- |
| \`html\` | A rendered HTML page with optional assets such as images | \`r3 guide html\` |
| \`files\` | A directory with a file browser | \`r3 guide files\` |
| \`diff\` | An independent captured patch | \`r3 guide diff\` |

## Publish

\`r3 create --kind <kind> <capture flags> [--title T]\` publishes version 1. The preparation guide supplies capture flags. \`--kind\` is required; the kind stays fixed. Share the returned URL.

\`r3 publish <id> <capture flags> [--expected <seq>] [--key K]\` adds a version containing the complete file set or independent patch. Prepare builds before capture. \`--expected\` checks the latest published sequence, not which version you revised; if omitted, r3 reads the latest sequence. On conflict, inspect the newer publication. For a lost-response retry, preserve captured bytes, expected sequence, key, and metadata.

Search retained work with \`r3 search "keyboard focus" --history all --json\`. Matches carry explicit publication, document/line or rendered-text evidence, and feedback/reply identity. Use \`--type conversation\` for messages or \`--attention\` for active artifacts awaiting human review. Search never acknowledges feedback or claims work.

Optional \`--version-label\` names the published version; \`--summary\` describes it. The CLI detects the Git remote for server-configured project grouping. Explicit \`--project\` overrides inference; details and artifact metadata flags are in \`r3 --help\`.

## Receive feedback

Claude Code and Codex publications register the publisher as fallback through a persistent local worker and the selected backend. A newer publication replaces that fallback; unsupported publishers or \`--no-listen\` clear it. Publication stays successful if listener setup fails, with a warning. Registration and restart do not send pending feedback.

\`r3 listen <id>\` explicitly takes priority over the fallback. \`r3 unlisten <id>\` removes your registrations; a later publication can register again. The worker persists registration intent and opens no TCP port. Exit 0 confirms registration, not session liveness; unsupported adapters require watch or polling. Send failures remain visible to the human: fallback registrations remain for retry, while failed explicit listeners are removed. There is no automatic resend to the fallback. Codex success means queued, including when its session is not running. A notification tells you to fetch feedback.

Local and remote modes share the same backend contract. The CLI reads and writes directly to the selected backend; the worker receives notifications through an outgoing connection and delivers them locally. Disconnect removes its live registrations. Reconnect restores saved roles only if the artifact has no incumbent recipient, including a publisher fallback. Conflicts stop automatic attempts until a fresh CLI action. Archive and superseded registrations never return. \`r3 listen --foreground\` remains accepted for compatibility; listening uses the persistent worker.

\`r3 watch <id> [--timeout <seconds>]\` works with any harness that can run the CLI, without supplying a session ID. It takes priority over a fallback until its request ends. Exit 10 confirms feedback was written to stdout and its snapshot acknowledged; 0 means archived, 2 means timeout, and 4 means another recipient superseded the request or the feedback snapshot changed before acknowledgment. On a snapshot conflict, fetch again. Handle expected nonzero exits explicitly, including under \`set -e\`. Treat other failures as errors. An artifact can retain fallback and explicit registrations with one selected recipient.

\`r3 feedback fetch <id> [--all] [--feedback <id,id>]\` reads new feedback, replies, and status changes, writes them to stdout, then explicitly acknowledges that snapshot. Failed reads or output leave feedback pending. If acknowledgment fails or concurrent edits conflict, the command fails: fetch again, allowing repeated output. A successful acknowledgment records handoff, not proof that a model processed the output.

After acknowledgment, fetch registers the calling agent as the explicit listener when its harness supports listening, using the local worker and a direct backend registration. Listener setup failure only warns on stderr; the fetched data stays on stdout and the command succeeds. Unsupported agents can fetch without an identity. \`--human\` skips registration. \`--all\` reads open history without acknowledgment or listener registration; add \`--feedback <id,id>\` to read specific threads, including resolved ones. \`r3 show <id>\` includes all open/resolved history.

When no agent is listening, the web UI's **Use in agent** button shows a copyable fetch command. Run \`! r3 feedback fetch <id>\` in your harness to feed its output into context. Copying the command leaves feedback pending until it runs. Use the existing payload when feedback was returned by watch or a harness command.

## Handle feedback

\`r3 claim <feedback-id>...\` accepts multiple IDs, as shown above. Claims are renewable 60-minute leases; another live holder conflicts. Use \`r3 release <feedback-id>...\` when abandoning work. A resolved-status notification needs no action.

Feedback may include images. Labels such as \`[image1]\` refer to the numbered attachment in that same note or reply. Download them with the supplied \`r3 feedback image\` command and open them with your harness's image-viewing tool before responding. A text reference does not load pixels into the model. Alternatively, \`r3 feedback fetch <id> --attachments-dir ./feedback-images\` downloads and verifies all images in the snapshot before acknowledging it. Capture context describes observed pixels; it does not establish a selector or source line. Use repeatable \`--attach <image>\` on feedback and replies to provide visual evidence.

Inspect original targets in their recorded version and representation. Rendered selectors, quotes, routes, and viewports describe the published page, not source lines. Reuse matching local source when revising your own publication; retrieve published content only when needed, such as an older version or another agent's work. Inspection/download commands are in \`r3 --help\`.

Source/diff quotes may be shortened excerpts; the recorded start/end lines retain the full selection. \`r3 feedback source <feedback-id>\` retrieves every captured line in that original version, file, and diff side, with line numbers. Add \`--json\` for range metadata and text. This read does not acknowledge feedback, claim it, or register a listener. Rendered, general, and whole-file targets have no captured line range and return an error.

Publish changed content, then \`r3 reply <feedback-id> -m <message>\`. Reply separately to each thread. References use the comment's own target when present, otherwise the discussion's original target. General discussions without a version stay unbound. Include \`--target\` whenever a published fix location can be verified. Supply JSON with \`kind\`, \`versionSeq\`, \`path\`, and \`locator\`, as above. Source locators use \`start\`, \`end\`, and exact \`quote\`; diff adds \`side\`; rendered uses a verified \`selector\` with optional quote/route. These targets use a null locator for the whole file. Media targets always retain a frame and one bounding box, defaulting to the full frame; see \`r3 guide files\` for \`--frame\` and timestamp details. The fix target also supplies the version/view for inline references. Omit it when no published location applies; never guess one. Original targets remain immutable; use \`place\` from \`r3 --help\` for additional verified source/rendered/diff placements.

Successful replies release only your own claims. Publishing and replying never resolve feedback; the human controls status. Complete the requested work, reply, and keep listening when requested. Archive ends the waiting loop and removes all saved registrations; restore requires fresh registration.`;

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

For image/video feedback, use a native \`media\` target and supply the full unannotated
PNG/JPEG snapshot with \`--frame\`. The locator is \`{time, box}\`: time is one instant in
seconds without rounding, or null for a still image; box is normalized
\`{x,y,width,height}\` within the intrinsic frame, defaulting to the full frame.
The saved frame is authoritative; video seeking may show a neighboring frame.
PNG, JPEG, static WebP and browser-decodable video are supported. Animated images
remain whole-file feedback. For example:

\`r3 reply feedback_a --version 2 --view media -m 'Improved caption contrast.' --target '{"kind":"media","versionSeq":2,"path":"clip.mp4","locator":{"time":6.3,"box":{"x":0.1,"y":0.7,"width":0.8,"height":0.2}}}' --frame ./fixed-frame.png\`

\`r3 feedback fetch <id> --attachments-dir ./feedback-images\` also downloads the
original and fix snapshots; \`r3 feedback image\` retrieves an individual frame.
Inspect those saved pixels and the normalized box instead of reconstructing the
original by seeking. Only agent replies with explicit media fix targets qualify
for media Compare; replying leaves resolution to the human.

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

Git capture runs on the publisher. Changed submodule pointers are always included in the patch, regardless of Git's submodule display or ignore settings. Submodule contents are not captured recursively. The server stores the captured patch and context. A later publication should express the complete intended review against its chosen base. The stdin path carries the supplied patch; context outside that input is unavailable.

Patch text must be valid UTF-8. Invalid text bytes are rejected instead of replaced; publish non-UTF-8 files as a files artifact to preserve their original bytes. Git binary patches remain supported.

## Diff targets

Read the captured patch with \`r3 patch <id> --version <seq>\`. For a new line target, \`feedback add\` accepts \`--file <path> --version <seq> --view diff --side old|new --line <start-end> --quote <captured text>\`.

The side distinguishes removed and added content. Line numbers and quote text must match the selected captured side. Omit side, line, and quote for a whole-file diff target. Use the main guide for original evidence, additional placements, and replying with a native fix target.`;

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
