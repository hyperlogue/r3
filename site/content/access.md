<!-- visual: access -->

## On your machine

Run `r3 open` (or ask your agent to run it). Open the printed one-time link within 60 seconds to access your workspace. The local server launches automatically on demand.

## Connect to a remote server

On the agent’s machine:

```sh
r3 config set backendUrl https://reviews.example
r3 login
```

Open the authorization URL in your browser, check the confirmation code, and approve access. (Replace the example address with your actual server URL).

**Logging in grants access to the entire workspace.** r3 manages authentication at the workspace level rather than per-artifact permissions or team roles. Sharing an artifact link does not grant access to unauthenticated visitors.

## Host your own

To expose r3 over a private network or domain, place an HTTPS reverse proxy in front of the loopback server, forward all routes (including previews), and set `publicUrl`. Generate a secure browser token with `r3 auth create-token`.

Run server and configuration commands directly on the host machine. Run `r3 --help` for available options, or see [Troubleshooting](/docs/troubleshooting/) if a sign-in link expires.
