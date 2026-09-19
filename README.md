> [!WARNING]
> This README describes an **unreleased version** with major changes to r3.
> For the latest released version, see the [README at tag v0.13.0](https://github.com/hyperlogue/r3/blob/v0.13.0/README.md).

<p align="center">
  <img src="web/favicon.svg" alt="r3 logo" width="120" height="120">
</p>

<h1 align="center">r3: A shared workspace for humans and agents</h1>

<p align="center"><b>Bring agent-created pages, documents, and code to life.<br>A Claude Artifacts-style workspace for any coding agent.</b></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@hyperlogue/r3"><img src="https://img.shields.io/npm/v/@hyperlogue/r3?color=cb3837&amp;logo=npm&amp;label=%40hyperlogue%2Fr3" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license: MIT"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey" alt="platforms: macOS, Linux">
  <a href="https://hyperlogue.github.io/r3/demo/"><img src="https://img.shields.io/badge/live-demo-6164ff?logo=googlechrome&amp;logoColor=white" alt="live demo"></a>
</p>

r3 gives agent output a place to be read, used, and discussed. Open interactive
HTML, browse documents and files, or inspect code changes. Select an element or
passage, leave feedback, and continue the conversation beside the work.

Agents publish complete, versioned artifacts through a CLI or HTTP API. Every
version stays available, and you choose when to switch to a revision. r3 runs
locally or on a remote machine; publishing works with any agent that can run the CLI.

[Try the browser demo](https://hyperlogue.github.io/r3/demo/) to explore HTML,
Markdown, and diff feedback with a scripted agent. It uses bundled examples;
production preview protection is not simulated.

## Get started

```sh
npm install -g @hyperlogue/r3
# Alternatives: bun add -g @hyperlogue/r3 · npx @hyperlogue/r3@latest
```

Ask your agent to run `r3 guide`. It explains how to publish, listen for feedback,
and reply. The first local call starts the daemon automatically. The CLI prints an
artifact URL; open `http://127.0.0.1:8791/` for the full list.

```sh
# Publish a prepared directory as an interactive page.
r3 create --kind html --dir ./prototype --title "Prototype"

# Reuse the returned artifact ID for revisions and feedback.
r3 listen artifact_example
r3 feedback fetch artifact_example
r3 claim feedback_example
r3 publish artifact_example --dir ./prototype --version-label "Revised prototype"
r3 reply feedback_example -m "Updated the explanation." --version 2 --view rendered
```

Use `r3 start`, `stop`, `status`, and `restart` to manage the daemon.
Run `r3 --help` for the complete command reference.

## Choose an artifact

| Artifact | What you can do | Try it for |
| --- | --- | --- |
| Interactive pages (`html`) | Interact with a page and leave feedback on specific elements or text | Prototypes, dashboards, interactive tutorials |
| Documents and files (`files`) | Read formatted documents, browse related files, and discuss specific passages or lines | Design proposals, research reports, generated project files |
| Code changes (`diff`) | See what changed and discuss it beside the affected lines | Bug fixes, refactors, feature reviews |

```sh
r3 create --kind files --dir ./proposal --title "Design documents"
r3 create --kind diff --working --title "Navigation changes"
```

HTML presents a page without a file browser. Choose files when you want to browse
several documents and assets together, or diff when the changes themselves are
what you want to review.

Read `r3 guide html`, `r3 guide files`, or `r3 guide diff` for preparation details.
Build dependencies before publishing and include supporting assets. Save large
images as standalone files with relative URLs instead of embedded base64.

## Review together

1. Open a version and select text to add feedback. HTML comment mode also lets
   you select page elements. Threads retain their original version and location.
2. Post your feedback, then choose **Send to agent** or **Copy prompt** for manual
   handoff. Drafts survive view changes; post or discard them before sending.
3. The agent claims the relevant threads, publishes a revision, and replies.
   Named fix links can point directly to updated HTML elements.
4. Use **Go to the latest version** when ready. New publications leave your
   current view in place. Resolve threads when satisfied; agent replies do not
   resolve them automatically.
5. Archive completed work. Versions and conversations remain readable, and
   restoring an artifact lets work continue.

The feedback panel can be docked, floating, or hidden. Comment anchors can open
individual conversations while the panel is hidden. Mobile uses a feedback sheet.

Each agent has a distinct logical identity, usually inferred from its harness;
`--session` or `R3_AGENT_SESSION` supplies one explicitly. Multiple agents can
publish and participate in the same artifact. Claims are renewable 60-minute
leases on individual feedback items. A reply releases only its author's claim.

`r3 listen` supports Claude Code and Codex wake adapters. Other agents can use
`r3 watch <id>` or poll `r3 feedback fetch <id>`. Watch prints pending feedback
and exits 10; archive exits 0, timeout 2, and an occupied recipient slot 4. Only
one designated listener or watcher receives an artifact's handoff at a time.
Restoring an archived artifact requires registering a listener again.

## Versions and projects

Publications are immutable snapshots that stay readable even after their source
directory is gone.
Publish the complete directory each time. Unchanged blobs are deduplicated across
versions, and the browser shows storage usage. Deletion removes the whole artifact;
individual versions cannot be deleted.

```sh
r3 versions artifact_example
r3 files artifact_example --version 1
r3 download artifact_example --version 1 --file image.png > image.png
r3 list
```

Concurrent publishers can use `--expected` to check the latest sequence and `--key`
for retry identity. Source and download commands require an explicit version.
Additional Git capture options are listed in `r3 --help`.

Projects optionally group artifacts. r3 infers a group from a sanitized Git remote;
use `r3 project create --title "Product design"` and `create --project <id>` to
choose one explicitly. Later publications preserve the group. Project deletion
leaves its artifacts intact.

## Interactive previews

Publish scripts, styles, images, and data alongside your page. Relative URLs,
hash routes, and links to published pages work. Backend hosting and automatic
dependency installation are outside r3's scope.

Previews run in opaque-origin sandboxes, with access scoped to one published
version and external connections blocked by default. The **Preview security**
entry in the three-dot menu explains the current protection. Browsers without
verified network blocking ask for risk acknowledgment before rendering interactive
content; compatibility mode retains isolation but can leave outbound channels open.

HTML artifacts can explicitly **Allow external access**, with optional camera and
microphone access. Browser device permission is also required. Enable this only
for trusted content: published files, conversations, input, and shared device data
could be sent externally. **Restore protection** blocks external access; **Stop
sharing** ends device capture. Version changes and leaving the preview clear
these grants.

Pages can use `/r3/utility.js` to access this artifact's conversations, create
feedback, reply, submit, persist a theme choice, or request device capture. It
exposes no application credentials or general API access. See the
[HTML authoring guide](docs/artifacts/html-authoring.md)
and [security model](.claude/skills/security-model/SKILL.md) for details.

Opened Markdown is cached for faster revisits: up to 64 MiB, with unused entries
expiring after 30 days. Cached text can appear after normal authentication while
preview checks run. Logout and known artifact deletions clear relevant entries.

## Remote access and storage

r3 binds loopback. Use an HTTPS reverse proxy or tunnel for remote browser access,
and forward the whole application, including `/__r3_preview/`. Existing Tailscale
Serve addresses work automatically; no wildcard DNS or separate preview port is needed.

```sh
r3 config set publicUrl https://reviews.example
r3 config set requireLogin 1
r3 restart
r3 auth create-token --label browser
```

Publish remotely with `R3_URL` and `R3_TOKEN`. Browser login uses a separate,
revocable token and session cookie. The server never needs a publisher checkout.
`r3 config show|get|set|unset` manages configuration; changes apply after restart.

Back up both `$XDG_STATE_HOME/r3/r3.sqlite` and its neighboring
`r3.sqlite.artifacts/` directory. Upgrading from live-file reviews creates a
private database backup and imports retained content and conversations. Historical
gaps remain explicit; see [storage and migration](docs/artifacts/schema.md).

## Development

```sh
bun install
process-compose up          # isolated development daemon
bun run storybook           # component workshop
bun run typecheck
bun test
biome check .
bun run build               # self-contained ./r3 binary
```

The daemon, CLI, and SPA ship as one binary. Frontend changes require a source-daemon
restart. The static demo is built with `bun run gen:demo` and `bun run build:demo`.
See [AGENTS.md](AGENTS.md) for architecture, the [design](docs/artifacts/design.md)
for behavior, and the [verification guide](docs/artifacts/verification.md) for checks.
