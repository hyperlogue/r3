## Install the skill

Run this in your terminal, then choose your coding agent:

```sh
npx skills add hyperlogue/r3 --skill publish-artifacts-to-r3 --global
```

The skill handles setup. Reviews run on your machine by default; you can also [connect your own server](/docs/access/).

## Ask your agent to publish

> Build a project-creation form with a visibility setting. Publish it to r3 and share the link so I can review it.

Open the link your agent gives you. If local sign-in is needed, ask it to run `r3 open` and open the fresh link.

<!-- visual: workspace -->

## Make your first review

1. Try the page normally.
2. Turn on **comment mode**, select something, and describe the change.
3. Choose **Send to agent**. Without a listener, **Use in agent** gives you a command to paste into your agent.
4. Inspect the revision and **Resolve** the thread when you are happy.

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
