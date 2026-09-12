<p align="center">
  <img src="web/favicon.svg" alt="r3 logo" width="120" height="120">
</p>

<h1 align="center">r3: Review. Revise. Resolve.</h1>

<p align="center"><b>Chat is a terrible UI for reviewing large amounts of agent-generated code and docs.<br>r3 is where you do it instead.</b></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@hyperlogue/r3"><img src="https://img.shields.io/npm/v/@hyperlogue/r3?color=cb3837&amp;logo=npm&amp;label=%40hyperlogue%2Fr3" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license: MIT"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey" alt="platforms: macOS, Linux">
  <a href="https://hyperlogue.github.io/r3/demo/"><img src="https://img.shields.io/badge/live-demo-6164ff?logo=googlechrome&amp;logoColor=white" alt="live demo"></a>
</p>

r3 is a workspace for reviewing what agents publish: documents, interactive HTML,
files, and code changes. Leave a comment on the source or rendered page, discuss it
in a thread, and inspect the next version when it is ready.

Each publication is immutable. Editing a local file does not change the page you
are reading. An agent can publish from another machine, and every version remains
available even after its source directory disappears.

```sh
npm install -g @hyperlogue/r3
# Alternatives: bun add -g @hyperlogue/r3 · npx @hyperlogue/r3@latest
```

The [browser demo](https://hyperlogue.github.io/r3/demo/) lets you try source and
diff feedback with a scripted agent. Executable previews need the daemon's isolated
preview host and are unavailable in the static demo.

## Publish an artifact

Run `r3 guide` for the full agent workflow. Give each agent a distinct logical
identity with `--session`, `R3_AGENT_SESSION`, or its harness-provided session ID.
No agent owns an artifact: multiple agents can publish and participate.

```sh
# A prepared directory of documents or files; no Git repository is needed.
r3 create --dir ./proposal --title "Proposed design" --session design-agent

# A full-page HTML or Markdown artifact with supporting assets.
r3 create --kind html --dir ./prototype --title "Prototype" --session design-agent

# Captured code changes, including untracked files.
r3 create --working --title "Navigation changes" --session code-agent

# Follow-up publications use the existing artifact's kind.
r3 publish artifact_example --dir ./proposal --label "Revised design" --session design-agent
```

The CLI prints the artifact URL. Its first local call starts the daemon; open
`http://127.0.0.1:8791/` for the artifact list. `r3 start`, `stop`, `status`, and
`restart` manage that daemon explicitly.

| Kind | What is published | What the browser shows |
| --- | --- | --- |
| `files` | A complete, nonempty directory; individual empty files are allowed | File browser and source viewer, with rendered HTML/Markdown, native media previews, and downloads |
| `html` | A complete directory with root `index.html` or `index.md` | The rendered entrypoint in a full-page workspace, with comment mode |
| `diff` | One complete, independent unified patch per version | Captured old/new lines, split or unified layout, and expandable retained context |

Directory capture defaults to `files`, even when it contains an index. For `html`,
if both indexes exist, choose `--entrypoint index.html` or `--entrypoint index.md`.
The artifact's kind stays fixed. Files and HTML artifacts have no diff view.

Other capture options are `--staged`, `--commit <sha>`, `--diff <base>..<head>`,
`--stdin-diff`, and `--ref <git-ref|STAGED> --file <relative-path>` (repeatable).
A diff version is an independent patch; r3 never applies it to an earlier version
to invent a complete tree.

Build HTML and bundle dependencies before publishing. Directory capture includes
all selected regular files, including hidden files; use a prepared output directory
or explicit `--file` selections. Symlinks and special files are rejected. Current
limits are 10,000 files, 64 MiB per file, 128 MiB total, 4 MiB per Markdown document,
and 10 MiB per patch.

## Review and revise

1. Open the artifact and choose a published version. Source selections, diff
   selections, and rendered comment mode create threads with native targets.
2. Click **Submit** to notify the registered agent, or copy the prompt for a manual
   handoff. Drafts retain the version and view where they began.
3. The agent reads pending feedback, claims the items it is handling, publishes
   changes, and replies by stable feedback ID.
4. Inspect the new publication using the version picker. A publication announces
   itself without replacing the version you are reading. Resolve the thread when
   you are satisfied; replies and publications leave its status open.
5. Archive the artifact when work should stop. Restore it to resume later.

```sh
r3 listen artifact_example --session design-agent
# Any agent can instead block on watch, or fetch prompt directly.
r3 watch artifact_example --session design-agent
r3 prompt artifact_example --session design-agent
r3 claim feedback_example --session design-agent
r3 publish artifact_example --dir ./proposal --session design-agent
r3 reply feedback_example -m "Updated the explanation." --version 2 --view source --session design-agent
```

`listen` uses a publisher-side Claude Code socket or Codex queue adapter. Its local
capability check reports when that adapter is unavailable; use `watch` or `prompt`
with other harnesses. The server receives an outward connection and logical agent
identity, never the harness socket, executable path, or harness credential.

`watch` exits **10** for pending feedback, **0** for archived, **2** on timeout, and
**4** for a conflicting or superseded recipient. Only one designated listen/watch
recipient is active per artifact. Claims are independent, feedback-scoped leases
lasting 60 minutes; agents can work on different notes concurrently. A reply
releases only its author's claim.

Original comment targets never move. **Locate** returns to their recorded version
and representation. Additional placements and reply fix targets are separate from
the original evidence; an absent or ambiguous element is reported explicitly.
Reply `--version` and `--view` pin its inline references independently of a fix
location. Without those flags, a reply has no version context.

Archive preserves versions, threads, unsent feedback, and drafts. An optional
archive message is retained in history and sent to the current listener. A blank
message closes quietly; watch always terminates. Archive does not imply approval.
Restore requires a fresh listener registration. In-flight replies remain accepted
while archived, but new publications, claims, and ordinary handoffs are blocked.

## Version history and retrieval

```sh
r3 versions artifact_example
r3 files artifact_example --version 1
r3 source artifact_example --version 1 --file index.md
r3 download artifact_example --version 1 --file image.png > image.png
r3 patch artifact_example --version 1 > captured.patch
r3 list --meta session=design-agent
```

All versions remain available until whole-artifact deletion. To correct content,
publish again. Concurrent publishers use an optimistic sequence check; `--expected`
sets it explicitly and `--key` identifies a retry. Retry with the same captured
bytes, metadata, key, and expected sequence. A conflict requires inspecting the
newest publication before publishing again.

Projects are optional explicit groups, independent of filesystem paths:
`r3 project create --title "Product design"`, then `r3 create ... --project <id>`.
Removing a project preserves its artifacts.

## Interactive HTML

Publish local scripts, ES modules, styles, images, media, and data alongside the
entrypoint. Use relative URLs, hash routes, or published document paths. The preview
provides the selected version's resource root. Automatic root-relative URL rewriting,
history-route fallback, dependency installation, and backend hosting are outside
this feature.

Each document runs in an opaque-origin sandbox with URL access scoped to one version. Local resources support
fetch, XHR, modules, and media range requests. External resources, APIs, sockets,
forms that navigate, and access to unrelated artifacts or application endpoints
are blocked. Bundle assets locally instead of loading a CDN.

Rendering requires a browser that passes r3's Connection Allowlist and WebRTC
blocking checks. Acceptance tests pass in Chrome for Testing 153.0.8010.36;
Chromium 151 is refused before loading published content. Unsupported browsers
still support source, diff, and download workflows. Persistent storage, workers,
nested frames, camera, and microphone are unavailable in the opaque sandbox.

Pages can import `/r3/utility.js` to call `getContext()`, `getThreads()`,
`createFeedback({ body, locator })`, `reply({ feedbackId, body })`, `submit()`, and
`subscribe(callback)`. These use the same threads and explicit handoff as the panel.
Human mutations require user activation. The utility exposes no application
credential, generic API access, publication, lifecycle, or host execution capability.

## Remote publishing and browser access

Point a publisher at an application URL with `R3_URL`; supply its API credential
through `R3_TOKEN`. Capture still happens on the publisher. Neither publishing nor
reading requires a server-side checkout.

Both daemon listeners bind loopback. Reach them through a tunnel or HTTPS reverse
proxy. For remote browser rendering, configure separate application and preview
origins; one preview endpoint routes to its listener. It can use the same hostname
on another HTTPS port. Wildcard DNS and certificates are unnecessary.
Do not proxy the application API through the preview host.

```sh
r3 config set publicUrl https://reviews.example
r3 config set requireLogin 1
r3 config set previewBaseUrl https://preview.example
r3 restart
r3 auth create-token --label browser
```

Forward the configured preview host and port unchanged to the preview listener
(default port 8792). A remote application requires an HTTPS preview endpoint; an HTTP localhost preview is only suitable for a local browser.
An SSH setup can instead forward both local ports while browsing the local
application URL.

Remote exposure enables login by default. A revocable login token mints an
HttpOnly browser session; it is separate from the CLI's API credential. Behind a
proxy that rewrites Host, set `requireLogin` explicitly and advertise `publicUrl`.
`r3 auth list-tokens` and `r3 auth revoke-token <id>` manage browser access.

Settings resolve environment → `$XDG_CONFIG_HOME/r3/config.json` → defaults:

| Setting | Environment | Default |
| --- | --- | --- |
| `port` | `R3_PORT` | 8791 |
| `bind` | `R3_BIND` | Loopback |
| `publicUrl` | `R3_PUBLIC_URL` | Local application URL |
| `allowedHosts` | `R3_ALLOWED_HOSTS` | Exact local hostnames |
| `requireLogin` | `R3_REQUIRE_LOGIN` | Enabled for remote exposure |
| `previewPort` | `R3_PREVIEW_PORT` | Application port + 1 |
| `previewBaseUrl` | `R3_PREVIEW_BASE_URL` | `http://localhost:<previewPort>` |

Use `r3 config show|get|set|unset` to inspect or persist settings. Wildcard
application hosts and all-interface binds are rejected.

## Upgrading from live file reviews

The artifact protocol replaces the old review commands and API. Restart with the
new binary to migrate. Startup first retains a private database backup, then
imports surviving snapshots, patches, conversations, login state, and read progress
in one transaction. Review IDs remain valid artifact URLs.

Files and scratch reviews become `files` artifacts. A one-time current capture,
when available, is explicitly marked as nonhistorical. Missing original bytes,
removed rounds, uncertain anchors, and inferred metadata stay documented as
migration evidence. Empty historical publications receive a clearly generated
notice. Sequence gaps remain reserved. Approved and abandoned reviews become
archived with their old outcome preserved in provenance.

State lives at `$XDG_STATE_HOME/r3/r3.sqlite`; immutable blobs and migration backups
live beside it in `r3.sqlite.artifacts/`. Back up both. The daemon announces itself
at `$XDG_RUNTIME_DIR/r3/daemon.json`. If startup fails, `r3 __daemon` runs in the
foreground to show the error; failed migration leaves the old database intact.

## Development

```sh
bun install
process-compose up          # isolated workspace data; app 8891, preview 8892
bun run storybook           # component workshop
bun run typecheck
bun test
biome check .
bun run build               # self-contained ./r3 binary
bun run gen:demo            # regenerate canned publications
bun run build:demo
```

The source daemon bundles the browser on startup. Server changes restart it under
`bun --watch`; restart after frontend edits to rebuild its guarded assets, or use
Storybook for component development. See [AGENTS.md](AGENTS.md) for the module map
and [the verification guide](docs/artifacts/verification.md) for browser and
compiled-binary acceptance commands.
