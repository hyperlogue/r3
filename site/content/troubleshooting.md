## Feedback didn't reach the agent

Click **Use in agent** and paste the copied command into your agent’s chat session. Copying the command does not dispatch comments by itself—your agent must run it to fetch the batch.

If delivery fails, run `r3 worker status`. If you see a sandbox warning, run `r3 worker restart` from a standard host terminal outside your agent's sandboxed environment.

## An expected revision isn't showing

Click **Go to the latest version** in the navbar. Local edits on disk do not appear in r3 until your agent explicitly publishes a new version.

If images, fonts, or stylesheets appear broken, verify whether the agent bundled those assets locally. Remote web resources are blocked by default unless granted through the [permission prompt](/docs/permissions/).

## An element target is missing

Click **Locate** to find the anchor in the version you are viewing. If it cannot be matched, r3 explains why and keeps that version selected. Use the history icon beside the anchor to open its original location or last recorded location in the saved version. If an element moved or changed identity, ask your agent to re-anchor the thread or provide a linked fix target in its reply. For diffs with limited context, ask the agent to capture more surrounding lines.

## Sign-in or mutations stopped working

A loopback-only server needs no login by default. If you see a token prompt, check for `requireLogin=true`, an external hostname in `publicUrl` or `allowedHosts`, or configured `trustedProxies` with `r3 config show`. On your own machine, run `r3 open` and open the printed link within 60 seconds to sign in. If the server refuses to start with login turned off, remove the external `bind`, `publicUrl`, `allowedHosts`, or `trustedProxies` settings, or run `r3 config unset requireLogin`; also check whether `R3_REQUIRE_LOGIN` overrides the saved setting. With login off, the server rejects forwarded requests with HTTP 403; configure `publicUrl` and keep login on when setting up a reverse proxy. After upgrading r3 or changing server settings, restart the server to load them. See [Configuration](/docs/configuration/) for the login policy and overrides.

When browser login is required, use a browser login token from that server. For immediate sign-in on the server's machine, `r3 open` provides a one-time link valid for 60 seconds. If it expires before use, run `r3 open` again. Ordinary artifact links from agents do not expire and do not sign you in automatically. If CLI access is rejected, check the selected backend URL and run `r3 login` again; this authorizes the CLI rather than signing the browser in.

Make sure archived artifacts are **restored** before trying to edit or comment.

If you see protocol warnings between the CLI and server, update both binaries to matching versions. If you encounter unexpected bugs, [open an issue on GitHub](https://github.com/hyperlogue/r3/issues) with reproduction steps (excluding private code and credentials).
