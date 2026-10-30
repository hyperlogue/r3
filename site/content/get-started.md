## Install the skill

Run this in your terminal, then choose your coding agent:

```sh
npx skills add hyperlogue/r3 --skill publish-artifacts-to-r3 --global
```

The skill configures your agent automatically. Reviews run locally on your machine—no accounts or external servers required unless you choose to [connect your own server](/docs/access/).

## Ask your agent to publish

> Create a project-creation form with a visibility setting. Publish it to r3 and share the link so I can review it.

Open the link returned by your agent whenever you are ready; artifact links contain no expiring sign-in code. A local server needs no sign-in by default; if you turn login on, `r3 open` provides a one-use sign-in link valid for five minutes. It keeps an existing login or signs the browser in normally. See [Local & remote access](/docs/access/).

<!-- visual: workspace -->

## Make your first review

1. Test the interface directly.
2. Turn on **comment mode**, click any element that needs adjustment, and write your note.
3. Click **Send to agent**. If your agent is not running in the background, click **Use in agent** and paste the command into your chat.
4. Inspect the agent's revision, compare the changes, and click **Resolve** once you are satisfied.

[Try the example](/example/index.html) or learn [how to give precise feedback](/docs/feedback/).

## Other installation methods

Or install the CLI:

```sh
npm install -g @hyperlogue/r3
```

```sh
bun add -g @hyperlogue/r3
```

On NixOS:

```sh
nix run github:hyperlogue/r3#r3 -- guide
```

Then ask your agent to read `r3 guide`. Use `r3 --help` for commands.
