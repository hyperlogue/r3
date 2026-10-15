## Feedback didn't reach the agent

Click **Use in agent** and paste the copied command directly into your agent’s chat session. (Note: simply copying the command does not dispatch comments—your agent must execute it to fetch the snapshot).

If delivery encounters an error, have your agent run `r3 worker status`. If you see a sandbox warning, run `r3 worker restart` from a regular host terminal outside the agent's restricted sandbox.

## An expected revision isn't showing

Click **Go to the latest version** in the navbar. Remember that live local edits on disk don't appear in r3 until your agent explicitly publishes a new version.

If images, fonts, or stylesheets look broken, verify whether the agent bundled those assets locally. Remote web resources are blocked by default unless granted in the [permission prompt](/docs/permissions/).

## An element target is missing

Click **Locate** to return to the original version where the feedback was anchored. If an element was refactored or moved, ask your agent to provide a linked fix target in its reply. For diffs with insufficient context, ask the agent to capture more surrounding lines.

## Sign-in or mutations stopped working

For local sessions, run `r3 open` to generate a fresh 60-second sign-in link. For remote servers, verify your backend URL and run `r3 login` again. Make sure archived artifacts are **restored** before trying to edit or comment.

If you encounter protocol warnings between the CLI and server, update both to matching versions. For any unexpected bugs, [open an issue on GitHub](https://github.com/hyperlogue/r3/issues) with reproduction steps (excluding private code and credentials).
