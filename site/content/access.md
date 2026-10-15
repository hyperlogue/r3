<!-- visual: access -->

## On your machine

Ask your agent to run `r3 open`. Open the printed sign-in link within 60 seconds. Run it again if the link expires. The local server starts when needed.

## Connect an existing server

On the agent’s machine:

```sh
r3 config set backendUrl https://reviews.example
r3 login
```

Open the authorization URL in your signed-in browser, check the code, and approve access. Replace the example address with your server’s URL.

**A login grants access to the whole workspace.** r3 has no per-artifact sharing permissions or separate team accounts. Sending someone an ordinary artifact URL does not sign them in.

## Host your own

Ask your administrator or agent to put an HTTPS proxy in front of the loopback server, forward the whole application including previews, and configure `publicUrl`. Create a browser login token with `r3 auth create-token` and keep it private.

Run configuration and server commands on the server’s machine. Use `r3 --help` for exact options. For a missed handoff or expired login, see [Troubleshooting](/docs/troubleshooting/).
