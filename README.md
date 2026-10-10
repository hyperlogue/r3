<p align="center">
  <img src="web/favicon.svg" alt="r3 logo" width="120" height="120">
</p>

<h1 align="center">r3: Render. Review. Refine.</h1>

<p align="center"><b>View AI-generated artifacts. Leave precise comments.</b><br>HTML pages, Markdown documents, and code from any coding agent.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@hyperlogue/r3"><img src="https://img.shields.io/npm/v/@hyperlogue/r3?color=cb3837&amp;logo=npm&amp;label=%40hyperlogue%2Fr3" alt="npm version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="license: MIT"></a>
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey" alt="platforms: macOS, Linux">
  <a href="https://hyperlogue.github.io/r3/demo/"><img src="https://img.shields.io/badge/live-demo-6164ff?logo=googlechrome&amp;logoColor=white" alt="live demo"></a>
</p>

r3 is a tool for reading, using, and discussing agent output.
Open an interactive page, read a document, or inspect code changes. Select an
element or passage to leave comments and continue the conversation with your agent.

Agents publish artifacts through a CLI or HTTP API. r3 works with any agent that
can run the CLI.

[Try the browser demo](https://hyperlogue.github.io/r3/demo/) to explore HTML,
Markdown, and code discussion with a scripted agent. It uses bundled examples;
production preview protection is not simulated.

[![Numbered workflow showing a human asking an AI agent to create an artifact on r3, reviewing it, sending comments, and reviewing the agent's revisions and comments.](https://github.com/user-attachments/assets/26506cba-3d1a-493c-9c7a-e6ae2227718c)](https://github.com/user-attachments/assets/26506cba-3d1a-493c-9c7a-e6ae2227718c)

## Screenshots

| Screenshot | What it shows |
| --- | --- |
| [![Reviewing an HTML UI proposal](https://github.com/user-attachments/assets/2dec1368-6679-47cb-aa19-bfeb6228a7d6)](https://github.com/user-attachments/assets/2dec1368-6679-47cb-aa19-bfeb6228a7d6) | Review a UI improvement proposal and leave comments directly on HTML elements. |
| [![Exploring a library through an interactive demo](https://github.com/user-attachments/assets/396df7ca-661e-414d-952b-0a6325638c62)](https://github.com/user-attachments/assets/396df7ca-661e-414d-952b-0a6325638c62) | Learn how a library works internally through an interactive demo. |
| [![Codex receiving comments from r3](https://github.com/user-attachments/assets/8e85f3d9-d03b-45ec-b478-fe7fe109ef19)](https://github.com/user-attachments/assets/8e85f3d9-d03b-45ec-b478-fe7fe109ef19) | Codex receives a direct message from r3 when you ping the agent from the web page. |

Search your library by project, content, or conversation. Results open the matching
publication or message, and **Include history** searches older versions. Agents can
use the same search with `r3 search "keyboard focus" --history all --json`.

## Get started

Install globally to make the `r3` command available on your PATH:

```sh
npm install -g @hyperlogue/r3
# Or: bun add -g @hyperlogue/r3
```

Or run it without installing `r3` on your PATH:

```sh
npx @hyperlogue/r3@latest
```

Ask your agent to run `r3 guide` and publish an artifact. The guide explains how
to publish, listen for comments, and comment. Open the artifact URL from your agent, or visit
`http://127.0.0.1:8791/` for the full list.

## Artifact types

r3 supports three kinds of artifacts:

| Artifact | What you can do | Examples |
| --- | --- | --- |
| HTML pages | Interact with a page and leave comments on specific elements or text | Prototypes, dashboards, interactive tutorials |
| Documents and files | Read rendered Markdown, browse related files, and discuss specific passages or lines | Design proposals, research reports, generated project files |
| Code changes | See what changed and discuss it beside the affected lines | Bug fixes, refactors, feature reviews |

HTML artifacts open as pages; files artifacts have a file browser; diff artifacts
show captured code changes.

For ideas on using HTML for plans, reports, and interactive explanations, see
Anthropic's [The unreasonable effectiveness of HTML](https://claude.com/blog/using-claude-code-the-unreasonable-effectiveness-of-html).

## Usage and cleanup

Open usage statistics beside Settings to see library totals and recent activity,
or use the CLI:

```sh
r3 stat                 # daily activity for the last 14 days
r3 stat --weekly        # weekly activity for the last 4 weeks
r3 gc --dry-run         # preview expired archives
r3 gc                   # permanently remove them
```

Cleanup is manual and defaults to 30 days after archiving. Set the server default
with `r3 config set archiveTtlDays 30`, then restart to apply it. The web Settings
panel offers the same cleanup with a confirmation. You can also select artifacts
on the home page to archive or permanently delete them together.

## Local and remote access

r3 starts a local server automatically when needed. Run `r3 open` for a browser link.

### Expose an r3 server

To access an r3 server from another device, put it behind an HTTPS reverse proxy.
For [Tailscale Serve](https://tailscale.com/docs/reference/tailscale-cli/serve),
connect the server and accessing devices to your tailnet. Run these commands on
the **server**, replacing `https://reviews.example` with its Tailscale HTTPS address:

```sh
r3 config set publicUrl https://reviews.example
r3 config set trustedProxies 127.0.0.1
r3 server restart
tailscale serve --bg http://127.0.0.1:8791
r3 auth create-token --label browser
```

Open the HTTPS address in your browser and sign in with the generated token.

For another proxy, forward the whole application to `http://127.0.0.1:8791/`
and set `X-Forwarded-Proto: https`. Set `trustedProxies` to its connection IP only
if it overwrites `X-Forwarded-For`.

### Connect the CLI to a remote server

To use an existing remote r3 server, install r3 on your **CLI or agent machine**
and set `backendUrl` to that server's HTTPS address:

```sh
r3 config set backendUrl https://reviews.example
r3 login
```

Open the printed address, sign in to r3 if needed, confirm that the code matches
your terminal, and approve CLI access. Then check the connection:

```sh
r3 list
```

Ask your agent to run `r3 guide` and publish as usual. See the
[remote backend reference](docs/artifacts/remote-protocol.md) for more options.
