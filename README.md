> [!WARNING]
> This README describes an **unreleased version** with major changes to r3.
> For the latest released version, see the [README at tag v0.13.0](https://github.com/hyperlogue/r3/blob/v0.13.0/README.md).

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

The [browser demo](https://hyperlogue.github.io/r3/demo/) lets you try HTML, rendered
Markdown, source, and diff feedback with a scripted agent. Its sandboxed previews
use bundled examples; the daemon’s verified network protection is not simulated.

## Publish an artifact

Run `r3 guide` for the full agent workflow. Give each agent a distinct logical
identity with `--session`, `R3_AGENT_SESSION`, or its harness-provided session ID.
No agent owns an artifact: multiple agents can publish and participate.

```sh
# A prepared directory of documents or files; no Git repository is needed.
r3 create --kind files --dir ./proposal --title "Proposed design" --session design-agent

# A full-page HTML or Markdown artifact with supporting assets.
r3 create --kind html --dir ./prototype --title "Prototype" --session design-agent

# Captured code changes, including untracked files.
r3 create --kind diff --working --title "Navigation changes" --session code-agent

# Follow-up publications use the existing artifact's kind.
r3 publish artifact_example --dir ./proposal --version-label "Revised design" --session design-agent
```

The CLI prints the artifact URL. Its first local call starts the daemon; open
`http://127.0.0.1:8791/` for the artifact list. `r3 start`, `stop`, `status`, and
`restart` manage that daemon explicitly.

| Kind | What is published | What the browser shows |
| --- | --- | --- |
| `files` | A complete, nonempty directory; individual empty files are allowed | Complete foldable file stack with rendered HTML/Markdown, native media previews, and downloads for binary or oversized files |
| `html` | A complete directory with root `index.html` or `index.md` | The rendered entrypoint in a full-page workspace, with comment mode |
| `diff` | One complete, independent unified patch per version | Captured old/new lines, split or unified layout, and expandable retained context |

Creation requires an explicit `--kind files|html|diff`, including for directories with an index. For `html`,
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

1. Open the artifact and choose a published version. Select text in source, diffs,
   rendered Markdown, or HTML to start feedback. Rendered comment mode also lets
   you pick whole page elements. Each thread keeps its native target.
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

Projects group artifacts independently of filesystem paths. To select one explicitly:
`r3 project create --title "Product design"`, then `r3 create ... --project <id>`.
Otherwise the CLI detects the Git fetch remote (prefer `origin`, then the configured
upstream or sole remote). The server groups equivalent repository URLs automatically,
with credentials removed. Ambiguous or non-network remotes leave an artifact ungrouped.
Later publications retain its project even when published from a different checkout.

Use `r3 project edit <id> --remote <url>` to attach a remote to an existing project.
On the server, `r3 config set projectGrouping manual` disables automatic grouping;
`remote` is the default. `projectMappings` accepts a JSON map of remote URLs to
existing project IDs for aliases. Configuration changes take effect after restart.
Removing a project preserves its artifacts and deletes its automatic remote mapping;
remove configured aliases separately.

## Interactive HTML

Publish local scripts, ES modules, styles, images, media, and data alongside the
entrypoint. Use relative URLs, hash routes, or published document paths. The preview
provides the selected version's resource root. Automatic root-relative URL rewriting,
history-route fallback, dependency installation, and backend hosting are outside
this feature.

Keep HTML small by saving images as standalone files, such as
`prototype/assets/hero.webp`, and using native HTML:

```html
<img src="./assets/hero.webp" alt="Hero illustration">
```

Extract large embedded base64/data-URL images into files and reuse their paths
when an image repeats. Publish the complete `prototype` directory on every version
so `index.html` and all referenced assets are included. See `r3 guide` for commands.

Each document runs in an opaque-origin sandbox with URL access scoped to one version. Local resources support
fetch, XHR, modules, and media range requests. By default external resources, APIs, sockets,
forms that navigate, and access to unrelated artifacts or application endpoints
are blocked. Bundle assets locally instead of loading a CDN.

Every preview first checks whether the browser can enforce Connection Allowlists
and WebRTC blocking. Browsers that cannot show a one-time risk warning before
loading published content. Accepting enables limited network protection: ordinary
external resources stay restricted, but malicious scripts could send publication
data, review conversations, or your input through other browser features.
The opaque sandbox and r3 authentication remain enforced.

Acceptance is remembered for this r3 site in this browser. New previews always
try verified protection first, including after browser upgrades. Open the top
navigation’s three-dot menu and expand **Preview security** for details or
**Forget browser choice**. Forgetting stops compatible previews in open tabs. Declining keeps the preview closed. Isolation,
HTTPS, and server failures never bypass verification through this warning.

HTML artifacts offer **Allow external access**, with a confirmation before
reloading the preview. It lets pages load external dependencies and call APIs
subject to browser CORS. The dialog also has optional **Camera** and **Microphone**
checkboxes, initially off. Enabling them lets this page request those devices;
the browser still requires its own permission for r3. HTTPS and localhost work.
Files can use limited compatibility rendering, but have no broader external-access
or device opt-out. Diff artifacts have no rendered preview.

The **Preview security** row summarizes all mounted previews with one shield.
Green means every preview has verified protection; amber indicates limited
protection, external access, or device consent; red indicates active sharing or an
error. Expanding it shows each preview’s isolation, network, camera, and microphone
status. Device icons distinguish permission from active sharing. HTML retains
**Permissions** and **Restore protection**.
While a device is active, **Stop sharing** stops capture and clears device consent.
Device choices reset on page navigation; broader external-access and device grants
reset on version changes or leaving the preview. These grants are never saved;
the separate compatibility risk acknowledgment is remembered. Browser site permissions may
remain remembered, but cannot replace r3's consent for the current page.

Only enable external access for trusted content. The page and external scripts
can send published files, your input, this artifact's conversations, and any shared
camera/microphone data elsewhere. Restoring protection cannot undo data already
sent. The opaque sandbox and r3 authentication remain enforced.

External pages reached through navigation keep the iframe's sandbox and device
restrictions, but do not inherit the published document's CSP. They can use workers
and nested frames that r3-served documents block. Such navigation is permitted in
external mode and may also occur through compatibility-mode gaps.

Pages can import `/r3/utility.js` to call `getContext()`, `getThreads()`,
`createFeedback({ body, locator })`, `reply({ feedbackId, body })`, `submit()`,
`subscribe(callback)`, `getTheme()`, `setTheme(theme)`, and `getUserMedia(constraints)`.
Conversations use the same threads and explicit handoff as the panel. Human mutations require user activation.
The utility exposes no application credential, generic API access, publication,
lifecycle, or host execution capability.

Pages can use `getTheme()` and `setTheme()` with `"light"` or `"dark"` to remember
their choice for this artifact and r3 site in the browser. A write requires a user gesture.
This is optional: authored HTML controls its appearance; r3 does not automatically
persist arbitrary page state. Rendered Markdown follows r3’s application theme.
Theme preference never saves external-access or device grants.

In external mode, the runtime also adapts `navigator.mediaDevices.getUserMedia`
so existing pages can request camera/microphone without changing the iframe's
opaque origin:

```js
const stream = await navigator.mediaDevices.getUserMedia({
  video: { width: { ideal: 640 }, facingMode: "user" },
  audio: true,
});
video.srcObject = stream;
// Stop this page's tracks when done; r3 also provides Stop sharing.
stream.getTracks().forEach((track) => track.stop());
```

The trusted parent captures devices and relays a real `MediaStream` over WebRTC;
direct native iframe capture remains blocked. Capture needs external access and
the selected device permissions. One capture can run at a time. Video supports
width, height, frame rate, aspect ratio, and facing mode; audio supports echo
cancellation, noise suppression, automatic gain, sample rate, and channel count.
Unsupported constraints are rejected. Device enumeration, device IDs, screen
capture, and camera pan/tilt/zoom are unavailable.

The returned tracks are WebRTC receiver tracks, so their settings and subsequent
`applyConstraints()` do not control the physical device. Normal media playback and
recording work. Returned track `stop()`/`clone()` and stream `clone()` keep source
lifetimes coordinated; bypassing those methods or cloning a separately constructed
stream is outside this adapter's contract. r3's Stop sharing always stops the
physical devices, independently of the page's track bookkeeping.

## Remote publishing and browser access

Point a publisher at an application URL with `R3_URL`; supply its API credential
through `R3_TOKEN`. Capture still happens on the publisher. Neither publishing nor
reading requires a server-side checkout.

The daemon binds loopback. Reach it through a tunnel or HTTPS reverse proxy.
Rendered previews automatically use the same address as the r3 browser page,
including an existing Tailscale Serve HTTPS address. No wildcard DNS, separate
public port, or preview setting is required. Localhost also works automatically.

```sh
r3 config set publicUrl https://reviews.example
r3 config set requireLogin 1
r3 restart
r3 auth create-token --label browser
```

The proxy forwards the whole application, including `/__r3_preview/`, without
stripping that prefix. If it rewrites Host, the configured `publicUrl` identifies
the HTTPS edge; arbitrary forwarded host headers never choose a trusted origin.
Share artifact workspace links, not temporary preview URLs.

An optional `previewBaseUrl` override uses a separate loopback preview listener
(`previewPort`, default application port + 1). Forward that single HTTPS origin
to the preview listener, preserving its Host and URL paths. It can use the same
hostname on a different HTTPS port. Clear an old override with
`r3 config unset previewBaseUrl` and restart to return to automatic hosting.
An SSH setup only needs to forward the application port when using automatic
hosting and browsing the local application URL.

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
| `previewPort` | `R3_PREVIEW_PORT` | Application port + 1, only with an explicit preview endpoint |
| `previewBaseUrl` | `R3_PREVIEW_BASE_URL` | Automatic: the browser's r3 address |

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
process-compose up          # isolated workspace data; application 8891
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
