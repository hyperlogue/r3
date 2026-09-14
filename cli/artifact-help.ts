export const ARTIFACT_HELP = `r3 — published artifacts and human/agent conversations

  create [--kind files|html|diff] <capture flags> [--title T] [--summary S]
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
         --ref <git-ref|STAGED> --file <relative-path>...
         --stdin-diff | --working | --staged | --commit <sha> | --diff <base>..<head>
Publication summaries belong to versions. Artifacts have no overview field.
Publication: --entrypoint index.html|index.md --label L --summary S --key K
Create: --project ID --meta k=v (repeatable); directory capture defaults to files.
HTML images: publish standalone assets with relative <img src> URLs; see r3 guide.

  feedback add <id> -m <message> [target flags]
  feedback edit <feedback-id> [-m <message>] [--status open|resolved --human]
  feedback delete <feedback-id>
  reply <feedback-id> -m <message> [--version <seq> --view source|rendered|diff]
        [--target <JSON fix target>]
  place <feedback-id> --target <JSON document target> --state anchored|unplaced|ambiguous
  claim <feedback-id>... | release <feedback-id>...
  prompt <id> [--all] [--feedback <id,id>]
  watch <id> [--timeout <seconds>]
  listen <id>                                # local wake adapter, outward stream
  archive <id> [-m <archive-message>] [--key K] | restore <id> [--key K]
  project list | project create [--title T] [--remote URL] | project delete <id>

Targets: --target <JSON> or --file <path> --version <seq> --view source|rendered|diff
         [--line <start-end> --quote <text>] [--side old|new]
         rendered: --selector <CSS> [--quote <text>] [--route <query/hash>]
         no target flags means general artifact feedback.
         Version descriptions are read-only metadata, not feedback targets.
Identity: --session <logical-agent-id> (or R3_AGENT_SESSION, then harness session).
          --human explicitly acts as the human owner. Distinct agents need distinct IDs.
Text flags accept - to read stdin. --json prints structured results.
Remote: R3_URL selects the application URL; R3_TOKEN supplies its API credential.

  auth create-token [--label L] | list-tokens | revoke-token <id> | revoke-token --all
  config show|get|set|unset ...
  start | stop | status | restart | guide

Rendered previews automatically use the browser's r3 address (HTTPS or localhost).
Optional previewBaseUrl selects a separate endpoint; previewPort defaults to the
application port + 1 only for that override. Wildcard subdomains are unnecessary.
Configuration names:
bind, port, publicUrl, allowedHosts, requireLogin, previewPort, previewBaseUrl.
Environment overrides: R3_PREVIEW_PORT and R3_PREVIEW_BASE_URL.
`;

export const ARTIFACT_GUIDE = `${ARTIFACT_HELP}
An artifact has one fixed kind and immutable published versions. Prepare complete
directory contents locally and publish them; changing local files does not change
what the human sees. Files artifacts have a file browser and source/rendered
views. HTML artifacts use a rendered workspace and require index.html or index.md
at the root. If both exist, name --entrypoint. Diff versions are independent sparse
patches, not a reconstructed tree. All versions remain until whole-artifact deletion.

For HTML publications, keep index.html small: save image assets as standalone
files such as assets/hero.webp and load them with native HTML:
  <img src="./assets/hero.webp" alt="Hero illustration">

Extract large embedded base64/data-URL images into files and reuse the same path
where an image repeats. Publish the complete prepared directory, including every
referenced asset, on each version:
  r3 create --kind html --dir ./prototype
  r3 publish <id> --dir ./prototype
An index.html-only capture omits companion files. Relative URLs resolve from the
document; a leading / addresses the preview origin, not the publication directory.
The preview also supplies a version-root URL for constructing asset URLs.
Prepare dependencies and assets before publishing; r3 does not build or install
them. Use hash routes or published document paths for navigation.

Create publishes version 1 after capturing locally. Publish reads the latest
published sequence for its optimistic concurrency check; --expected overrides it.
--key makes a lost-response retry return the original publication. Keep the same
captured content, expected sequence, key, and metadata when retrying. A conflicting
publisher requires inspecting the latest version and making a new publication.

Set R3_AGENT_SESSION or --session to a stable distinct ID when your harness does
not provide one, and always give logical subagents distinct IDs. The same artifact
can receive publications and replies from any registered agent. No agent owns it.

Artifact JSON includes unhandledCount: open threads whose latest message is from
an agent. Reading, delivery, and claims do not clear it; a human reply or resolution does.
storage.totalBytes counts distinct original/retained blobs across published versions
plus each patch's UTF-8 bytes. storage.latestVersionBytes is the latest publication's
full footprint (zero before publication), independent of the selected version.
These exclude database/filesystem overhead. Shared blobs count toward each artifact;
the total is not the space that deleting an artifact would necessarily reclaim.

Open the printed artifact URL for human feedback. Use listen for Claude Code or
Codex when their local wake adapter is available; it keeps a publisher-side process
connected outward to r3. Other agents use watch or poll prompt. The daemon never
needs access to your checkout, executable, harness socket, or harness credential.
One designated listen/watch connection is supported at a time. A successful wake
confirms notification delivery; feedback remains pending until prompt acknowledges it.

Run prompt to fetch and acknowledge pending owner feedback; --all reads open
history without acknowledging anything. Claim the feedback IDs you will handle.
Read native targets in their recorded version and representation. Rendered
selectors, text, route, and viewport are page evidence, not source-line mappings.
Original targets never move. Place records additional verified placements; a fix
target belongs on a reply, separately from the reply's explicit message context.

Publish complete updated contents or an independent patch, then reply by stable
feedback ID. --version and --view pin the reply's inline references. Omit both for
a message without version context. Publishing and replying never resolve feedback;
the human changes open/resolved status. A successful reply releases only its
author's claim. Claim leases are renewable for 60 minutes.

Watch exits 10 for pending feedback, 0 for archived, 2 on timeout, 4 when another
recipient holds the slot or this connection was superseded. Branch on the exit
code. Archive is terminal even when unsent feedback exists. A nonblank archive
message is saved and sent to the current listener; a blank message closes quietly.
Restore permits publication again, but requires a fresh listener registration.
Archive delivery failure does not undo the archived state or its saved message.

Previews try verified network blocking first. Published image files load within
that protection; they do not need an external network grant.
Browsers without enforcement need a one-time risk acknowledgment for limited
protection. Only the human can enable broader external access for HTML or share
devices through separate r3 consent and browser permission.
`;
