import { styleText } from "node:util";
import { R3_VERSION } from "../shared/version.ts";
import { ArtifactCommandError } from "./artifact-args.ts";

export function artifactWelcome(): string {
  return `
  ${styleText(["bold", "cyan"], "r3")}  Understand what's built. Steer what's next.  ${styleText("dim", `v${R3_VERSION}`)}

  Review files, pages, and code changes with your agent.

  ${styleText("cyan", "r3 server start")}     Start the local server and show its URL
  ${styleText("cyan", "r3 server status")}    Show local server status and URL
  ${styleText("cyan", "r3 list")}             List your artifacts
  ${styleText("cyan", "r3 --help")}           All commands and options

  ${styleText("bold", "Agents:")} run ${styleText("cyan", "r3 guide")} before publishing or handling threads.
`;
}

export const ARTIFACT_HELP = `r3 — published artifacts and human/agent conversations

Run r3 for a quick start. Agents: start with r3 guide.

  create --kind files|html|diff <capture flags> [--title T] [--summary S]
  publish <id> <capture flags> [--expected <seq>] [--key <retry-key>]
  list [--state active|archived] [--kind K] [--project ID] [--meta k=v] [--mine]
  search <query> [--state active|archived] [--kind K] [--project ID]
        [--attention] [--history latest|all] [--type all|content|conversation]
        [--limit 1..100] [--offset N]
  show <id>
  versions <id>
  files <id> --version <seq>
  source <id> --version <seq> --file <path>
  download <id> --version <seq> --file <path>   # original bytes to stdout
  patch <id> --version <seq>                  # original unified diff
  edit <id> [--title T] [--meta k=v]
  delete <id>                                # whole artifact and history
  stat [--weekly]                            # current totals and activity
  gc [--dry-run] [--ttl 30d]                 # permanently remove expired archives

Capture: --dir <prepared-directory> [--file <relative-path>]...
         --ref <git-ref> --file <relative-path>...
         --stdin-diff | --working | --staged | --commit <sha> | --diff <base>..<head>
Publication: --version-label L --summary S --key K --no-listen
             (--label is an alias of --version-label; do not supply both)
Create: --kind is required; --project ID --meta k=v (repeatable).
Search: quote multiword queries; words match as prefixes (up to 16 words / 256 characters).

  thread add <id> [-m <message>] [--attach <image>]... [--key K] [target flags]
  thread edit <thread-id> [-m <message>] [--status open|resolved --human]
        [--attach <image>]... | [--clear-attachments]
  thread delete <thread-id>
  comment <thread-id> [-m <message>] [--attach <image>]... [--key K]
        [target flags] [--frame <snapshot.png>] [--expected N --expected-anchor R]
  comment fetch <artifact-id> [--all] [--threads <id,id>] [--attachments-dir <directory>]
  comment show <comment-id>                  # opening, follow-up, or archive Comment
  comment edit <comment-id> [-m <message>] [--attach <image>]... | [--clear-attachments]
  comment image <id> --image <image-id> [--output <file>] # bytes to stdout otherwise
  claim <thread-id>... | release <thread-id>...
  thread source <thread-id>               # full captured ORIGINAL source/diff range
  thread reanchor <thread-id> [destination flags] [--expected-anchor N] [--key K]
  thread reanchor --artifact <id> --version N --input <json-file|-> [--key K]
  watch <id> [--timeout <seconds>]
  listen <id> | unlisten <id>
  archive <id> [-m <archive-comment>] [--key K] | restore <id> [--key K]
  project list | project create [--title T] [--remote URL] | project delete <id>
  project edit <id> [--title T] [--remote URL]

Targets: --target <JSON> or --file <path> --version <seq> --view source|rendered|diff
         [--line <start-end> --quote <text>] [--side old|new]
         rendered: --selector <CSS> [--quote <text>] [--route <query/hash>]
         media, shadow DOM and fix labels need --target JSON (r3 guide files, r3 guide html).
         Re-anchor destinations omit --quote. No target flags means a general thread.
Images: static PNG/JPEG, at most four per message, 5 MiB and 20 megapixels each.
        A message needs text or an image. --attach replaces all images; omitting it
        keeps them; --clear-attachments removes them.
Identity: detected from the harness (codex:, claude:, antigravity:); R3_AGENT_SESSION
          overrides it. --session <name> sets a display name. --human acts as the owner.
Output: text flags accept - to read stdin. Writes and versions/files/project print short
        lines; --json prints the complete result as compact JSON.
Retries: reuse the same --key (and any printed guards) for an unchanged write after an
         uncertain response.
Backend: R3_URL > nearest project .r3.json backendUrl > user backendUrl > local.

  login [--api-key-stdin]
  auth create-key [--label L] [--expires-days N] | list-clients | revoke-client <id> | audit
  auth create-token [--label L] | list-tokens | revoke-token <id> | revoke-token --all
  config show|get|set|unset ...
  open [artifact-id]                        # local sign-in links expire after five minutes
  server start|stop|status|restart            # local storage and browser server
  worker start|stop|status|restart            # local notification delivery
  start | stop | status | restart            # deprecated aliases; use server <command>
  guide [html|files|diff|page-utility|operations]

Server, worker, sign-in, configuration, version mismatch and cleanup details:
r3 guide operations.
`;

export const ARTIFACT_GUIDE = `# r3 — publish artifacts and respond to threads

r3 lets agents publish immutable versions of artifacts for humans to review and discuss. Each artifact has one discussion containing resolvable threads and authored comments. A reply is a comment in a thread; an archive comment belongs directly to the discussion. Run \`r3\` as a subprocess from your harness. Read this guide once per session.

## A typical review

Prepare \`./prepared/plan.md\`. Use the returned artifact ID and the thread IDs from the human's submission; the IDs below are examples.

\`\`\`sh
r3 create --kind files --dir ./prepared --title 'Design review'
artifact_id=artifact_example
# Share the printed URL. Claude Code, Codex, and Antigravity register automatically.

# When a comments-submitted notification arrives:
r3 comment fetch "$artifact_id"
r3 claim thread_a thread_b thread_c

# Inspect the recorded targets and revise the prepared files.
r3 publish "$artifact_id" --dir ./prepared --expected 1
# Suppose publication returned version 2, discussed in rendered view:
r3 comment thread_a -m 'Clarified ownership.' \\
  --target '{"kind":"rendered","versionSeq":2,"path":"plan.md","locator":{"selector":"#ownership"}}'
r3 comment thread_b -m 'Added the missing case.'
r3 comment thread_c -m 'Corrected the example.'
\`\`\`

Treat IDs as opaque. New artifact IDs are \`artifact_<22 alphanumeric characters>\` with no ordering; order by \`createdAt\`.

## Artifact kinds

Specify \`--kind html|files|diff\` at creation; the kind stays fixed. Read each preparation guide once per session, when that kind is first needed:

| Kind | Review surface | Guide |
| --- | --- | --- |
| \`html\` | A rendered HTML page with optional assets such as images | \`r3 guide html\` |
| \`files\` | A directory with a file browser | \`r3 guide files\` |
| \`diff\` | An independent captured patch | \`r3 guide diff\` |

For an HTML page where the human chooses from options and submits them back to you, also read \`r3 guide page-utility\`. Read \`r3 guide operations\` only when the server, worker, sign-in, notifications, versions or cleanup need attention.

## Publish

\`r3 create --kind <kind> <capture flags> [--title T]\` publishes version 1 and prints its stable URL. Share that URL; the human may read your reply later. The preparation guide supplies capture flags.

\`r3 publish <id> <capture flags> [--expected <seq>] [--key K]\` adds a version containing the complete file set or independent patch. Build before capture. \`--expected\` checks the latest published sequence, not which version you revised; if omitted, r3 reads it. On conflict, inspect the newer publication. For a lost-response retry, preserve captured bytes, expected sequence, key, and metadata.

\`--version-label\` names a version and \`--summary\` describes it; artifacts have no overview field. \`--project\` overrides the project inferred from the Git remote.

Warnings on stderr, such as a version mismatch, do not mean the command failed. Use the exit code, and never repeat a successful publication because of a warning. An incompatible protocol exits 1 before any write. Never restart a server without the user's explicit confirmation; \`r3 guide operations\` explains what to ask.

## Receive comments

Publishing from Claude Code, Codex, or Antigravity subscribes your session through a local worker. If setup fails, publication still succeeds with a warning; run \`r3 listen <id>\`. \`listen\` replaces any earlier subscription; \`r3 unlisten <id>\` ends yours. While subscribed, a pending review never blocks you: do not poll, watch, or announce that you are waiting. Continue other work or end your turn; a notification arrives in your session and tells you to fetch.

\`r3 comment fetch <id>\` prints pending comments and status changes with their context, then acknowledges that snapshot and subscribes the calling agent when its harness supports it. Failed reads or output leave comments pending. If acknowledgment fails, the command fails: fetch again, and expect repeated output. \`--all\` reads history without acknowledgment or subscription; \`--threads <id,id>\` selects threads, including resolved ones. \`r3 show <id>\` prints the whole discussion.

If \`listen\` exits 5, the harness has no notification adapter: use \`r3 watch <id> [--timeout <seconds>]\`. Exit 10 means comments were printed and acknowledged; process them. 0 means archived, 2 timeout, and 4 superseded or changed before acknowledgment (fetch again). Handle these exits explicitly, including under \`set -e\`.

When no agent is listening, the human may copy \`! r3 comment fetch <id>\` from the workspace into your harness. Process output already returned by watch or such a command instead of fetching again.

Archive notifies the listener of the latest version and any archive message, then ends all subscriptions. If delivery fails, an archive with a message stays active for retry with the same \`--key\` and message. Archived artifacts stay readable; content changes, comments and subscriptions conflict until \`r3 restore <id>\`, after which you need a fresh \`r3 listen\`.

\`r3 search "keyboard focus" --history all --json\` finds retained content and conversations, with publication, line or rendered-text evidence and thread/comment IDs. Use \`--type conversation\` for messages or \`--attention\` for active artifacts awaiting review. HTML search covers static entrypoint text; binary, invalid UTF-8 and text files over 4 MiB are excluded and counted. Search never acknowledges or claims.

## Handle threads

\`r3 claim <thread-id>...\` takes renewable 60-minute leases; another live holder conflicts. \`r3 release <thread-id>...\` abandons work. A resolved-status notification needs no action.

Each thread heading in fetch output names the original version, view, path, and line range or media time. \`Locator:\` adds the selector, quote or region; \`Moved to\` shows the current anchor. Inspect targets in their recorded version and view. Rendered selectors, quotes and routes describe the published page, not source lines. Reuse local source when revising your own publication. Source and diff quotes may be excerpts; \`r3 thread source <thread-id>\` prints every captured line (\`--json\` adds range metadata). Version summaries are not thread targets.

Labels such as \`[image1]\` refer to that message's numbered attachments. Download them with the \`r3 comment image\` command shown at the end of the fetch output, or pass \`--attachments-dir <dir>\` to fetch, which verifies every image before acknowledging and never overwrites a different file. Open images with your harness's image tool; the text alone does not load pixels. Capture details describe observed pixels, not a selector or source line. Use repeatable \`--attach <image>\` to supply visual evidence.

Publish changed content, then reply to each thread separately with \`r3 comment <thread-id> -m <message>\`. Add \`--target\` whenever you can verify the published fix location, and never guess one. The JSON has \`kind\`, \`versionSeq\`, \`path\` and \`locator\`: source uses \`start\`, \`end\` and an exact \`quote\`; diff adds \`side\`; rendered uses a verified \`selector\` with optional \`quote\`, \`route\` and \`label\`; a null locator means the whole file. Media targets are in \`r3 guide files\`; shadow DOM and fix labels are in \`r3 guide html\`. Without \`--target\`, a reply refers to the thread's target. A latest-version fix target also moves the thread's anchor atomically; an older-version target records only that reply's Fix. If another publication or anchor update races, neither the comment nor the move commits.

After each publication, re-anchor every open thread whose location you can verify in the latest version; leave uncertain ones unchanged. Either reply with a fix target, or move without replying: \`r3 thread reanchor <thread-id> --version N --file <path> --view source --line <start-end>\`. Destinations take coordinates, never a quote; rendered uses \`--selector\` and media uses \`--target\` plus \`--frame\`. Matching evidence comes from the retained published bytes, and original evidence never changes. Only the latest publication accepts moves; resolved threads can move, archived artifacts must be restored first.

For bulk moves, \`r3 thread reanchor --artifact <id> --version N --input ./anchors.json\` commits an array of 1–100 \`{threadId, expectedAnchorRevision, target, mediaSnapshot?}\` entries atomically. Revision 0 means never moved. Single-thread commands read the revision; \`--expected-anchor\` guards an earlier read. After an uncertain write, retry with the exact printed key and guards; a replay does not move the thread again.

Successful comments release only your own claims. Publishing and commenting never resolve threads; the human controls status. Complete the requested work, comment, and keep listening when requested.`;

const HTML_GUIDE = `# HTML artifacts

Read this once per session when HTML preparation is first needed; the main \`r3 guide\` covers publishing, listening, and commenting.

An HTML artifact presents a rendered page with optional assets such as images. The publication root must contain \`index.html\`; the user enters through that page. Markdown documents belong in files artifacts, or may be linked as companion documents from an HTML page. Previously published Markdown entrypoints remain readable.

Use a shared navigation bar or tabs so every review page is reachable from every other page, directly or through several steps. Make the index a useful starting page and expose assets through the page's content or controls. The workspace intentionally has no file browser, source toggle, or companion-file viewer. Publishing a file alone does not make it discoverable. Use a files artifact when the human should browse the directory freely.

\`\`\`sh
r3 create --kind html --dir ./prototype --title 'Prototype'
r3 publish <id> --dir ./prototype --version-label 'Revised prototype'
\`\`\`

\`create\` requires \`--kind html\`; the unique root index selects the starting document automatically.

## Prepare the directory

Build dependencies before capture. Publish every referenced local asset on every version. An index-only \`--file\` filter omits companion assets.

Keep large assets in standalone files so their bytes are reused when the page around them changes. Use the exact publication-root path (for example, \`models/example.gz\`) with the r3 asset helpers, even from a nested HTML page. A missing file rejects the read; check \`r3 files <id> --version <seq>\` if a published page is missing an asset.

For models, JSON, or other whole-file reads, prefer \`r3.readAsset(path)\`. It returns a \`Blob\` with the published media type. The workspace keeps the file in the browser by content, so identical bytes download once across refreshes, versions, paths, and artifacts. Read a model when the user selects it:

\`\`\`js
import r3 from "/r3/utility.js";

const model = await r3.readAsset("models/example.gz");
const bytes = await model.arrayBuffer(); // original compressed bytes
\`\`\`

Bundle startup JavaScript into an inline \`<script type="module">\` in \`index.html\` so the browser can reuse it with the cached HTML on refresh. Keep \`/r3/utility.js\` external when bundling.

If your artifact uses a WebAssembly module, include the \`.wasm\` file in the directory you publish. \`WebAssembly.instantiateStreaming(fetch(path), imports)\` and loaders that fetch the module reuse the cached bytes without changes.

Use ordinary \`src\` and \`srcset\` attributes for published images in static HTML. r3 prepares these attributes at publication and supplies the image bytes from the workspace cache when the page opens. With \`loading="lazy"\`, loading starts when the image becomes visible. For \`srcset\`, r3 reads the listed local candidates and the browser selects one using the original descriptors and \`sizes\`.

For an image created in JavaScript, leave \`src\` and \`srcset\` unset and call \`r3.bindImage(img, path)\`. Call the returned cleanup function when you remove the image. Give images an alt description and, optionally, dimensions to reserve space.

Use ordinary \`src\` on \`<video>\`, \`<audio>\`, and their \`<source>\` children, and \`poster\` on \`<video>\`, in static HTML. Media already in the workspace cache plays from it at once and seeks without network requests. On a first visit, a file up to 8 MiB downloads completely before playback starts; a larger file streams and is cached once it plays. With \`<source>\` children the first visit always streams. For media created in JavaScript, leave \`src\` unset and call \`r3.bindMedia(media, path)\`; call the returned cleanup function when you remove it. A URL with a media fragment such as \`clip.mp4#t=10\` streams on every visit.

Relative image URLs resolve from the document. External URLs and \`<picture>\` source elements use native loading.

\`fetch()\` of a published file reads from the same workspace cache, including \`Range\` requests. The response arrives once the whole file is available, so a first read does not stream. \`XMLHttpRequest\`, \`<script src>\`, stylesheets, and CSS \`url()\` load natively and download again on every visit.

For canvas pixel reads or export from a native image URL, set \`image.crossOrigin = "anonymous"\` before assigning \`image.src\` (or use \`<img crossorigin="anonymous" src="…">\`). Even published images otherwise taint the canvas in the isolated preview, causing \`SecurityError\`; r3 already supplies the required CORS headers.

Standard \`localStorage\` calls save browser-local state for this artifact across reloads and versions, isolated from r3 settings and other artifacts. Saved values are available to the first publisher script. Storage is limited to 256 KiB and 1,024 keys; logout and artifact deletion clear it. Downloads work through normal export buttons without an r3 permission prompt. Print/PDF remains unavailable.

## Preview and rendered threads

Bundle dependencies and assets locally: external requests are blocked by default. If the page requires external services or device access, explain that requirement to the human.

Nested browsing contexts and workers are blocked: \`<iframe>\`, \`<object>\`, \`<embed>\`, and \`Worker\` do not load, even for published files. Render device mockups and embedded screens directly in the page, using container queries for a phone width, or inside an open shadow root so rendered threads can still anchor there.

Links that leave the artifact work with absolute http(s) URLs. A link to another r3 artifact on the same server opens it in r3; other links, and any link a reader opens in a new tab, open in a new browser tab. Links to other sites first ask the reader to confirm the full address. Scripts cannot open links without a click.

Give important sections and controls unique, descriptive HTML IDs, such as \`id="pricing-comparison"\` or \`id="save-draft"\`. Keep each ID stable across revisions of the same element; avoid random IDs or IDs based on list position, and do not reuse an ID for an unrelated element. Stable IDs make rendered threads easier to anchor and inspect.

For a new rendered target, \`thread add\` accepts \`--file <path> --version <seq> --view rendered --selector <CSS>\` with optional \`--quote <text>\` and \`--route <query/hash>\`, or a complete \`--target <JSON>\` document target. Target the recorded page and route. The main guide explains original evidence and comment/fix references.

Comment mode can pick elements inside open shadow roots. For a CLI target there, use \`--target\` with \`locator.shadowHosts\`: an outer-to-inner array of host selectors, each resolved inside the preceding host's open shadow root. Resolve \`locator.selector\` inside the last root. For example, \`{"selector":"#save","shadowHosts":["#phone","settings-panel"]}\` identifies the save control in that phone's settings panel. Each host must match exactly once; missing or closed roots cannot resolve the exact target. Use at most 16 hosts and 4,096 characters per selector. Omit \`shadowHosts\` for ordinary document targets. Give repeated frames distinct stable host IDs; inner IDs need only be unique within their own root.

When commenting with a fix, choose a short, meaningful \`locator.label\` and pin it to a verified element using \`locator.selector\` and any \`shadowHosts\`. The HTML workspace displays **Fix: Storage help button**, rather than a filename. The label is plain text (1–200 characters) and names the location; the scoped selector and optional quote/route locate it. Keep \`path\` and \`versionSeq\` in the target to identify the published document. Verify every host matches once, then verify the final selector identifies exactly one visible element in its root on that published page and route. Recheck after publication; do not assume an old target still identifies the fix. Existing unlabeled targets display **Page element**, or **Page** for a null locator.

\`\`\`sh
r3 comment <thread-id> -m 'Added the storage explanation.' \\
  --target '{"kind":"rendered","versionSeq":2,"path":"index.html","locator":{"selector":"#storage-help","label":"Storage help button"}}'
\`\`\`

For a fix inside nested shadow roots:

\`\`\`sh
r3 comment <thread-id> -m 'Fixed the Save button.' \\
  --target '{"kind":"rendered","versionSeq":3,"path":"index.html","locator":{
    "shadowHosts":["#phone","settings-panel"],
    "selector":"#save","quote":"Save","label":"Settings Save button",
    "ancestors":[
      {"selector":"#settings-form","shadowDepth":2},
      {"selector":"settings-panel","shadowDepth":1},
      {"selector":"#phone","shadowDepth":0}
    ]
  }}'
\`\`\`

\`ancestors\` is optional, nearest-first evidence of actual parents. \`shadowDepth\` selects a prefix of \`shadowHosts\`: 0 means the document, 1 means the first host's root, and so on. Supply at most 16 ancestors, with nonincreasing depths and selectors of at most 4,096 characters. Browser picks capture this evidence automatically, stopping before body/html. CLI callers should supply only parents verified in that published DOM; omit it when unknown.

Locate retries the exact target first. If it remains unavailable, it shows the element matched by the selector alone when only its quote changed, otherwise the nearest visible, uniquely matched recorded ancestor, with a dashed outline and an explicit context notice. Saved shadow hosts provide a further fallback, including for older targets. Ambiguous exact targets remain ambiguous. Context fallback never changes the original target, creates an exact-match marker, or establishes that a fix was found; whole-page guesses and inferred parents from arbitrary CSS selectors are excluded.\n

## Interactive pages

A page can let the human choose from options and submit the choices directly back to you, and can adapt its layout while comment mode is on. Read \`r3 guide page-utility\` before building such a page; other HTML artifacts do not need it.`;

const FILES_GUIDE = `# Files artifacts

Read this once per session when files preparation is first needed; the main \`r3 guide\` covers publishing, listening, and commenting.

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

## Source and rendered threads

For a new source target, \`thread add\` accepts \`--file <path> --version <seq> --view source --line <start-end> --quote <captured text>\`. Omit line and quote for a whole-file target.

For image/video threads, use a native \`media\` target and supply the full unannotated
PNG/JPEG snapshot with \`--frame\`. The locator is \`{time, box}\`: time is one instant in
seconds without rounding, or null for a still image; box is normalized
\`{x,y,width,height}\` within the intrinsic frame, defaulting to the full frame.
The saved frame is authoritative; video seeking may show a neighboring frame.
PNG, JPEG, static WebP and browser-decodable video are supported. Animated images
remain whole-file threads. For example:

\`r3 comment thread_a -m 'Improved caption contrast.' --target '{"kind":"media","versionSeq":2,"path":"clip.mp4","locator":{"time":6.3,"box":{"x":0.1,"y":0.7,"width":0.8,"height":0.2}}}' --frame ./fixed-frame.png\`

\`r3 comment fetch <id> --attachments-dir ./comment-images\` also downloads the
original and fix snapshots; \`r3 comment image\` retrieves an individual frame.
Inspect those saved pixels and the normalized box instead of reconstructing the
original by seeking. Only agent comments with explicit media fix targets qualify
for media Compare; commenting leaves resolution to the human.

For rendered HTML/Markdown, use \`--view rendered\` with \`--selector <CSS>\` and optional \`--quote <text>\` and \`--route <query/hash>\`, or the recorded JSON target. Keep any companion assets in the publication and use relative document URLs. Rendered previews remain isolated; files artifacts do not receive the HTML-artifact external-access grant.

The main guide covers the discussion loop and native evidence. Use \`r3 --help\` for inspection and download commands.`;

const DIFF_GUIDE = `# Diff artifacts

Read this once per session when diff preparation is first needed; the main \`r3 guide\` covers publishing, listening, and commenting.

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

Read the captured patch with \`r3 patch <id> --version <seq>\`. For a new line target, \`thread add\` accepts \`--file <path> --version <seq> --view diff --side old|new --line <start-end> --quote <captured text>\`.

The side distinguishes removed and added content. Line numbers and quote text must match the selected captured side. Omit side, line, and quote for a whole-file diff target. Use the main guide for original evidence and commenting with a native fix target.`;

const PAGE_UTILITY_GUIDE = `# Page utility

Read this once per session before building an HTML artifact that collects input or adapts to comment mode; \`r3 guide html\` covers preparing the page itself.

The page utility helps you build interactive UI: the human chooses from options in the page, and the page submits those choices directly back to you. Each choice arrives as a thread through the normal comment fetch, so the human never has to type or copy an answer.

## Load the utility

\`\`\`html
<script type="module">
import r3 from "/r3/utility.js";
</script>
\`\`\`

r3 serves the module to every published HTML page of the artifact, and it is ready before your first script runs. Use exactly this specifier; a static import and \`await import("/r3/utility.js")\` both work. The module exists only in the r3 workspace. For a page that should also open from disk, use the dynamic import inside \`try\`/\`catch\` and keep the page readable without it.

## Collect choices and submit them

\`\`\`html
<form id="rollout">
  <fieldset id="rollout-question">
    <legend>How should we roll out the migration?</legend>
    <label><input type="radio" name="plan" value="staged" required> Staged, 10% per day</label>
    <label><input type="radio" name="plan" value="all"> All at once</label>
  </fieldset>
  <label>Notes <textarea name="notes"></textarea></label>
  <button type="button" id="send-choice">Send to agent</button>
  <p id="send-status" role="status"></p>
</form>

<script type="module">
import r3 from "/r3/utility.js";

const form = document.querySelector("#rollout");
const button = document.querySelector("#send-choice");
const status = document.querySelector("#send-status");

button.onclick = async () => {
  if (!form.reportValidity()) return;
  const data = new FormData(form);
  button.disabled = true;
  try {
    await r3.createThread({
      body: [
        "Rollout plan: " + data.get("plan"),
        data.get("notes") ? "Notes: " + data.get("notes") : "",
      ].filter(Boolean).join("\\n\\n"),
      locator: { selector: "#rollout-question" },
    });
    const { notification } = await r3.submit();
    status.textContent =
      notification.state === "none"
        ? "Saved. No agent is listening yet; it will read this on its next fetch."
        : "Sent to the agent.";
  } catch (error) {
    status.textContent = error.message;
    button.disabled = false;
  }
};
</script>
\`\`\`

Follow this shape:

1. Start from a click or key press on a \`type="button"\` control. The preview runs scripts without native form submission, so handle \`click\` and validate with \`form.reportValidity()\`. \`createThread\`, \`comment\`, and \`submit\` act as the signed-in human, so r3 accepts them only while the browser reports a recent user action. Call them at the start of the handler and one after another. That window lasts a few seconds: finish slow work such as animation or timers after the calls, not before.
2. Write a body that stands alone. You will read it later as plain comment text, without the page in front of you. Name the question and the chosen option by its stable value, and include any free text the human entered. The workspace renders the body as Markdown.
3. Anchor the thread. \`locator.selector\` points at the question or option the answer belongs to, so the human sees the thread on that element and you get the target back with the comment. Use a unique, stable \`id\`. Omit \`locator\` for an answer about the whole page.
4. Call \`submit()\` last. Threads and replies stay pending until it runs. It sends every pending comment on the artifact, including ones the human typed in the workspace, exactly as the workspace Submit button does.
5. Disable the control while the calls run. Every \`createThread\` call creates a new thread, so a double click would send the answer twice.
6. Show the result in the page. Each call rejects with an \`Error\` whose \`message\` is written for the human; display it and re-enable the control so they can retry.

Use one thread per independent question when you intend to answer each one separately; the human can then resolve them one by one. Use a single thread for a form that is one decision. To add to a thread the page already created, keep the returned \`thread.id\` and call \`comment({ threadId, body })\`.

## Methods

| Method | Resolves to |
| --- | --- |
| \`readAsset(path)\` | A \`Blob\` of the published file in this version |
| \`bindImage(img, path)\` | Returns cleanup immediately; loads the image when visible |
| \`bindMedia(media, path)\` | Returns cleanup immediately; plays cached audio or video, otherwise streams it |
| \`getContext()\` | \`{artifactId, versionSeq, path, resourceRoot, representation, state}\` |
| \`getThreads()\` | An array of threads on this artifact |
| \`createThread({body, locator?})\` | The new thread |
| \`comment({threadId, body})\` | The new comment |
| \`submit()\` | \`{notification: {state}}\` |
| \`subscribe(listener)\` | Returns an unsubscribe function immediately |
| \`isCommentMode()\` | Returns a boolean immediately |
| \`onCommentModeChange(listener)\` | Returns an unsubscribe function immediately |

\`createThread\` and \`comment\` accept exactly the keys shown. \`body\` holds 1 to 1,048,576 characters. \`locator\` takes \`selector\` with optional \`shadowHosts\`, \`ancestors\`, \`quote\`, \`prefix\`, \`suffix\`, \`route\`, and \`viewport\`, as described in \`r3 guide html\`; \`route\` starts with \`?\` or \`#\`. The thread is recorded against the version and page the human is viewing.

\`submit()\` resolves with \`state\` \`sent\` or \`queued\` when you were notified, and \`none\` when no agent is listening; the comments then wait for your next \`r3 comment fetch\`. It rejects when delivery fails, leaving the comments pending for another submit.

## Read the discussion

\`getContext()\` identifies the page. \`path\` is the published document, \`versionSeq\` the version on screen, and \`state\` is \`active\` or \`archived\`. Enable input controls only while \`state\` is \`active\`.

\`getThreads()\` returns every thread on the artifact, yours and the human's:

\`\`\`js
{
  id: "thread_…",
  status: "open",              // or "resolved"
  target: { kind: "rendered", versionSeq: 2, path: "index.html", locator: { selector: "#rollout-question" } },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  comments: [                   // opening comment first
    {
      id: "comment_…",
      author: { role: "human", sessionId: null },   // or { role: "agent", sessionId }
      body: "Rollout plan: staged",
      createdAt: "2026-01-01T00:00:00.000Z",
      sentAt: null              // set once the comment was delivered to you
    }
  ]
}
\`\`\`

Use it to restore the page after a reload or on a later version: find the thread anchored to a question through \`target.locator.selector\`, mark that question answered, and show your own replies (\`author.role === "agent"\`) beside it. A thread created by the page is an ordinary thread: reply with \`r3 comment <thread-id> -m <message>\`, and the human resolves it in the workspace.

\`subscribe(listener)\` calls \`listener()\` with no arguments after workspace updates, including new comments and status changes. Read \`getThreads()\` again inside it and render from the result.

\`\`\`js
const render = async () => showAnswers(await r3.getThreads());
r3.subscribe(render);
render();
\`\`\`

Keep unsent draft state, such as a half-filled form, in \`localStorage\`.

## Adapt to comment mode

In comment mode the human picks any element to comment on, so clicks select elements and your click handlers do not run. Content that needs a click to appear cannot be reached. r3 adds the \`r3-comment-mode\` class to the \`<html>\` element while the mode is on; use it to lay everything out for review.

\`\`\`css
.r3-comment-mode [role="tabpanel"][hidden] { display: block; }
.r3-comment-mode .accordion-body { display: block; }
.r3-comment-mode .ticker { animation-play-state: paused; }
\`\`\`

For changes CSS cannot express, read the state in script:

\`\`\`js
const apply = (on) => {
  for (const item of document.querySelectorAll("details")) item.open = on;
};
apply(r3.isCommentMode());
r3.onCommentModeChange(apply);
\`\`\`

\`isCommentMode()\` answers immediately and is \`false\` until the workspace reports otherwise, so always pair it with \`onCommentModeChange\`, which calls \`listener(on)\` each time the mode actually changes.

The plain \`c\` key toggles comment mode from inside the page unless focus is in an input, textarea, select, or editable region. Leave it unbound.

## After publishing

Tell the human that the page sends their choices to you when they press its button. Then follow the main guide: the notification arrives in your session, \`r3 comment fetch <id>\` returns each choice as a thread with its target, and you reply to those threads after acting on them.`;

const OPERATIONS_GUIDE = `# Operations

Read this when the server, worker, sign-in, notifications, versions, or cleanup need attention; the main \`r3 guide\` covers publishing and threads.

## Server versions

Incompatible backend protocols fail with exit 1 before the operation, with the server URL, both versions, and recovery guidance. Compatible release mismatches warn on stderr; \`r3 server start\` and \`status\` report them too. Wait for the user's explicit confirmation before restarting anything.

If the CLI is newer, ask the user to confirm restarting with the newer CLI when the server runs locally, or upgrading and restarting r3 on the server's machine when it is remote. A configured backend URL is managed separately; a local \`r3 server restart\` does not restart a remote host. If the server is newer, ask the user to upgrade or switch the CLI, and never restart the newer server with an older CLI. After switching CLI versions, read its guide again. Unknown development versions do not establish an upgrade direction; inspect and align the builds.

A latest-version \`comment --target\` needs a backend that supports thread anchors; an older backend is rejected before the reply is posted.

## Local server

\`r3 server start|stop|status|restart\` manages the local storage and browser server. The top-level \`start\`, \`stop\`, \`status\` and \`restart\` aliases warn on stderr and will be removed. Startup failures report the underlying error when available, the local address, and the discovery path; check them before retrying. A missing \`XDG_RUNTIME_DIR\` uses Linux's private user runtime directory when available; legacy state-directory discovery remains supported. Automatic CLI setup uses a private Unix socket. Rendered previews use the browser's r3 address (HTTPS or localhost).

## Identity

r3 infers identity from the harness: \`codex:<id>\`, \`claude:<id>\`, or \`antigravity:<id>\`. Generic writing agents and subagents can supply a distinct, stable \`R3_AGENT_SESSION\`, which overrides detection completely. \`--session <name>\` sets a readable display name and never changes identity. \`--human\` acts as the human owner. \`watch\` needs no supplied identity.

## Notification delivery

A persistent local worker receives notifications from the selected backend through an outgoing connection and delivers them to your harness; it opens no TCP port. Local and remote modes share the same backend contract. Each artifact can keep a publisher fallback and explicit subscriptions with one selected subscription. A newer publisher replaces the fallback when it registers; an unsupported publisher or \`--no-listen\` keeps the existing one. \`listen\` and \`watch\` take priority over the fallback, and a fresh \`listen\` from any agent replaces the explicit subscription. Subscription setup and restart never send pending comments. \`r3 listen --foreground\` remains accepted for compatibility.

Exit 0 from \`listen\` confirms setup, not session liveness. Codex and Antigravity success means queued, not processed. Delivery failures keep the selected subscription and are visible to the human in the browser; failed notifications are not resent automatically. Disconnects keep backend subscriptions and mark the selected one unavailable; the same worker and credential reconnect without changing selection, and a newer explicit subscription is never displaced. Replacement, unlisten, archive and deletion end subscriptions permanently. Upgrades discard legacy server-local subscriptions and destinations; run \`r3 listen <id>\` again. Current worker subscriptions are preserved.

The worker inherits the permissions of the CLI that starts it. New worker startup warns on stderr when it detects sandbox environment markers, since notifications may then fail even when commands succeed. Detection is best effort; reusing a running worker stays quiet. If the worker started inside a sandbox, run \`r3 worker restart\` from a terminal outside it. Stop and restart use authenticated IPC across PID namespaces and recover stale locks or unresponsive workers after checking local process identity.

Each backend/session destination has a private file under \`$XDG_STATE_HOME/r3/worker-targets/\` (default \`~/.local/state/r3/worker-targets/\`). The worker records the owning harness process, detecting the long-lived harness ancestor by process and command name and skipping temporary sandbox helpers. Set \`R3_AGENT_PID\` to a live same-user agent process when a custom launcher hides the harness. Hidden or unrecognized owners stay untracked and usable after the tool call exits. Startup and normal worker operations remove destinations of exited agents, throttled to once a minute plus a check before delivery; there is no cleanup timer. This removes local notification credentials; resume with a fresh \`r3 listen <id>\`. Unknown or inaccessible processes and older records without a PID are preserved. Backend session attribution and conversations remain intact.

Antigravity delivery uses \`agy agentapi send-message\` through its running local backend. Run r3 from Antigravity's agent command environment so it can capture the conversation ID, loopback address, messaging token, and source attribution; these stay in the private local worker. Keep the Antigravity session running; after restarting it, run \`r3 listen <id>\` again. A missing connection or unsupported executable makes \`listen\` exit 5.

## Sign-in and credentials

Backend selection: \`R3_URL\` > nearest project \`.r3.json\` \`backendUrl\` > user \`backendUrl\` > local. Remote backends always need \`r3 login\` (browser approval), or an API key piped to \`r3 login --api-key-stdin\`. Credentials are saved privately per backend; \`R3_TOKEN\` is not a client override. The worker retries temporary connection and refresh failures, including rate limits; rejected credentials require \`r3 login\` again.

A loopback-only local server needs no login by default; \`requireLogin=true\` opts in. An external bind, \`publicUrl\`, \`allowedHosts\`, or trusted proxies always require login, and \`requireLogin=false\` is refused. Without login the server refuses proxied requests and creates no login tokens or API keys. Host/origin and preview guards always apply.

On a protected local server, \`r3 open <id>\` prints a one-use sign-in link valid for five minutes; it needs no saved CLI credentials. Link tickets stay in memory. Opening one reuses a valid browser login; only a signed-out browser gets a new persisted login token and session, under normal expiry. No-login and selected backends use ordinary URLs. Agents should share the stable publication URL instead.

Login tokens expire after \`authTokenIdleDays\` of inactivity (default 14). Successful login or cookie authentication refreshes last use; unused tokens age from creation. Inactivity is checked when authenticating, startup removes inactive or revoked rows, and cookie-use timestamps are saved once per minute and at graceful shutdown. \`r3 auth\` manages API keys, clients, login tokens and the audit log.

## Configuration

\`r3 config show|get|set|unset\` edits the local config, even when \`R3_URL\` selects a remote backend. Settings take effect after a server restart. Names: \`backendUrl\`, \`bind\`, \`port\`, \`publicUrl\`, \`allowedHosts\`, \`requireLogin\`, \`authTokenIdleDays\` (positive integer), \`disableLoginNotice\` (true hides the browser's one-time no-login notice), \`trustedProxies\` (comma-separated immediate proxy IP addresses), \`archiveTtlDays\` (1..36500; default 30), \`projectGrouping\` (\`remote\`|\`manual\`), and \`projectMappings\` (JSON remote-URL to project-ID map). Environment overrides: \`R3_AUTH_TOKEN_IDLE_DAYS\`, \`R3_PROJECT_GROUPING\`, \`R3_DISABLE_LOGIN_NOTICE\`.

The CLI detects origin's fetch URL (then upstream or the sole remote), removes credentials, and sends it for project grouping; ambiguous remotes stay ungrouped. An explicit project wins over remote inference, mappings can group aliases under an existing ID, and later versions keep their artifact's project.

## Usage and cleanup

\`r3 stat\` shows current library totals and daily activity for the last 14 calendar days; \`--weekly\` shows the last four Monday-start weeks. Both use the server timezone and include the current partial period. Activity counts survive artifact deletion; pre-upgrade history covers surviving records only. Content size excludes database and filesystem overhead.

Cleanup is manual. \`r3 gc --dry-run\` previews archived artifacts past the TTL; \`r3 gc\` permanently removes them and their conversations without prompting, keeps shared content still in use, and reports failures with exit 1. The default TTL is 30 elapsed days since the latest archive; \`--ttl 1d..36500d\` overrides one run and \`r3 config set archiveTtlDays\` the default. Restore cancels eligibility; archiving again starts a new countdown. \`stat\` and \`gc\` support \`--json\`.

## Workspace links

A thread's primary link has no version label: it tries the saved anchor in the latest publication without writing a move, and returns to the saved location when there is no unique match. The original-position button and individual Fix links stay pinned. Explicit re-anchoring keeps navigation useful when content or paths change beyond exact matching.`;

export function artifactGuide(args: string[]): string {
  if (args.length > 1)
    throw new ArtifactCommandError(
      "guide expects at most one topic: html, files, diff, page-utility, or operations",
    );
  switch (args[0]) {
    case undefined:
      return ARTIFACT_GUIDE;
    case "html":
      return HTML_GUIDE;
    case "files":
      return FILES_GUIDE;
    case "diff":
      return DIFF_GUIDE;
    case "page-utility":
      return PAGE_UTILITY_GUIDE;
    case "operations":
      return OPERATIONS_GUIDE;
    default:
      throw new ArtifactCommandError(
        "Unknown guide topic. Choose html, files, diff, page-utility, or operations, or run r3 guide for the workflow.",
      );
  }
}
