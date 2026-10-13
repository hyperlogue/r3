You do the reviewing in the browser. Your agent prepares the work, publishes it, and responds to your feedback through the CLI.

## Install the skill

Install the [r3 publishing skill](https://github.com/hyperlogue/r3/tree/main/skills/publish-artifacts-to-r3) from your terminal:

```sh
npx skills add hyperlogue/r3 --skill publish-artifacts-to-r3 --global
```

Choose the coding agents you use when prompted. `--global` makes the skill available across your projects; omit it to install only in the current project.

The skill finds an available `r3` executable or runs it through `npx`, `bunx`, or the Nix flake on NixOS, then loads its agent guide. No global r3 installation is required. Prefer to run r3 yourself? See [other installation methods](#other-installation-methods).

By default, the workspace runs on your machine. To use an existing remote server, [select its backend and sign in](/docs/access/#select-a-backend-and-sign-in) before asking your agent to publish. The review workflow is the same in either setup.

## Ask your agent to publish

With the skill installed, give your agent a task:

> Make an interactive prototype of Example Fieldwork’s project-creation flow and publish it to r3. Include a project name, optional description, and visibility choice. Share the artifact URL so I can review it.

The agent can use any coding harness that runs commands. Supported harnesses receive comment notifications through a local worker, with either a local or remote backend. Other agents can wait with `r3 watch` or fetch comments when asked. You do not need to type the publication commands yourself.

## Open the workspace

Open the artifact link the agent gives you. For your first local browser sign-in, or to open the whole library, ask your agent to run:

```sh
r3 open
```

In local mode, the command prints a one-time sign-in link to open in your browser. The link expires after 60 seconds; run it again if needed. Use `r3 open <artifact-id>` for a specific review. For a remote backend, it prints that server’s URL, where you sign in with a browser login token.

A local server starts lazily when a command first needs it. Bare `r3` prints a welcome and quick-start commands; it does not start the server.

## Make your first review

1. Use the prototype normally to understand it.
2. Turn on comment mode and select the control or text you want to discuss.
3. Write a concrete comment: “Explain who can see a workspace project before I create it.”
4. Use **Send to agent**, or **Use in agent** when no listener is available.
5. Read the reply and open the new publication. Resolve the thread once you have checked the change.

**Use in agent** copies a `r3 comment fetch` command. Run it in the agent’s harness so the returned feedback becomes part of its context. Copying alone does not deliver your feedback.

## Other installation methods

You can use r3 directly without the skill. It ships as one self-contained binary for macOS and Linux.

### Install the CLI globally

Use npm or Bun to make the `r3` command available in your terminal and to your agent:

```sh
npm install -g @hyperlogue/r3
```

```sh
bun add -g @hyperlogue/r3
```

Then ask your agent to read `r3 guide` and publish its work.

### Run without a global install

Give your agent the guide through npm or Bun:

```sh
npx --yes @hyperlogue/r3@latest guide
```

```sh
bunx --bun @hyperlogue/r3@latest guide
```

On NixOS, use the Nix flake:

```sh
nix run github:hyperlogue/r3#r3 -- guide
```

For later commands, replace `r3` with your chosen runner: `npx --yes @hyperlogue/r3@latest`, `bunx --bun @hyperlogue/r3@latest`, or `nix run github:hyperlogue/r3#r3 --`.

## The commands worth knowing

| Command | When you need it |
| --- | --- |
| `r3 open [artifact-id]` | Open the library or a review; sign in automatically in local mode. |
| `r3 server start` | Start the local server explicitly. |
| `r3 server status` | Check whether it is running and find the URL again. |
| `r3 server restart` | Apply local server configuration changes. |
| `r3 server stop` | Stop the local server. |
| `r3 list` | Find your artifacts from the terminal. |
| `r3 --help` | See the complete command reference. |
| `r3 guide` | Give your agent its working instructions. |
| `r3 login` | Authorize the CLI for a selected remote backend. |
| `r3 worker status` | Check the notification worker’s backend connections. |

Server and worker commands always manage the local machine, even when artifact commands use a remote backend. See [Local & remote access](/docs/access/) for the complete setup.

Next, learn [the complete review loop](/docs/review-loop/) or work through the [project-creation example](/use-cases/prototype/).
