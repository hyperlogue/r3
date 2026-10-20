## Feedback didn't reach the agent

Click **Use in agent** and paste the copied command into your agent’s chat session. Copying the command does not dispatch comments by itself—your agent must run it to fetch the batch.

If delivery fails, run `r3 worker status`. If you see a sandbox warning, run `r3 worker restart` from a standard host terminal outside your agent's sandboxed environment.

## An expected revision isn't showing

Click **Go to the latest version** in the navbar. Local edits on disk do not appear in r3 until your agent explicitly publishes a new version.

If images, fonts, or stylesheets appear broken, verify whether the agent bundled those assets locally. Remote web resources are blocked by default unless granted through the [permission prompt](/docs/permissions/).

## An element target is missing

Click **Locate** on the thread to return to the original version where the comment was anchored. If an element moved or changed identity, ask your agent to provide a linked fix target in its reply. For diffs with limited context, ask the agent to capture more surrounding lines.

## Sign-in or mutations stopped working

For local sessions, run `r3 open` to generate a fresh 60-second sign-in link. For remote servers, check your backend URL and run `r3 login` again. Make sure archived artifacts are **restored** before trying to edit or comment.

If you see protocol warnings between the CLI and server, update both binaries to matching versions. If you encounter unexpected bugs, [open an issue on GitHub](https://github.com/hyperlogue/r3/issues) with reproduction steps (excluding private code and credentials).
