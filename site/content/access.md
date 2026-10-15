<!-- visual: access -->

## On your machine

Ask your agent to run `r3 open`. Click the printed one-time link within 60 seconds to open your workspace (run the command again if it expires). The local server launches on demand.

## Connect to a remote server

On the agent’s machine:

```sh
r3 config set backendUrl https://reviews.example
r3 login
```

Open the authorization URL in your browser, verify the confirmation code, and approve access. (Replace the example address with your actual server URL).

**Logging in grants access to the entire workspace.** r3 uses complete workspace access rather than granular per-artifact permissions or team accounts. Simply sharing an artifact URL won't sign another user in.

## Host your own

To expose r3 over a private network or domain, place an HTTPS reverse proxy in front of the loopback server, forward all routes (including previews), and set `publicUrl`. Generate a secure browser token with `r3 auth create-token`.

Run server and configuration commands directly on the host machine. Run `r3 --help` for full options, or see [Troubleshooting](/docs/troubleshooting/) if a login link expires.
