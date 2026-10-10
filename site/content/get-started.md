You do the reviewing in the browser. Your agent prepares the work, publishes it, and responds to your feedback through the CLI.

## Install r3

r3 ships as one self-contained binary for macOS and Linux. Install the launcher with npm or Bun:

```sh
npm install -g @hyperlogue/r3
```

```sh
bun add -g @hyperlogue/r3
```

Prefer to try it without a global install? Run `npx @hyperlogue/r3@latest`. When using that route, substitute `npx @hyperlogue/r3@latest` for `r3` in later commands. Global installation makes the shorter command available to your agent too.

## Ask your agent to publish

Give the agent a task and ask it to read the built-in guide:

> Read `r3 guide`. Make an interactive prototype of Example Fieldwork’s project-creation flow and publish it to r3. Include a project name, optional description, and visibility choice. Share the artifact URL so I can review it.

The agent can use any coding harness that runs commands. Supported harnesses receive comment notifications through a local worker, with either a local or remote backend. Other agents can wait with `r3 watch` or fetch discussions when asked. You do not need to type the publication commands yourself.

## Open the workspace

Open the artifact link the agent gives you. To open the whole library, run:

```sh
r3 start
```

The command prints your workspace URL. A local server starts lazily when a command first needs it. Bare `r3` prints a welcome and quick-start commands; it does not start the server.

## Make your first review

1. Use the prototype normally to understand it.
2. Turn on comment mode and select the control or text you want to discuss.
3. Write a concrete comment: “Explain who can see a workspace project before I create it.”
4. Use **Send to agent**, or **Use in agent** when no listener is available.
5. Read the reply and open the new publication. Resolve the thread once you have checked the change.

**Use in agent** copies a `r3 comment fetch` command. Run it in the agent’s harness so the returned feedback becomes part of its context. Copying alone does not deliver your feedback.

## The commands worth knowing

| Command | When you need it |
| --- | --- |
| `r3 start` | Start the local workspace and see its URL. |
| `r3 status` | Check whether it is running and find the URL again. |
| `r3 restart` | Apply local server configuration changes. |
| `r3 stop` | Stop the local server. |
| `r3 list` | Find your artifacts from the terminal. |
| `r3 --help` | See the complete command reference. |
| `r3 guide` | Give your agent its working instructions. |
| `r3 login` | Authorize the CLI for a selected remote backend. |
| `r3 worker status` | Check the notification worker’s backend connections. |

Next, learn [the complete review loop](/docs/review-loop/) or work through the [project-creation example](/use-cases/prototype/).
