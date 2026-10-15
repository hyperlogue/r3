## Feedback did not reach the agent

Use **Use in agent** and paste the copied command into your agent’s conversation. A notification may wait for a paused session; copying the command alone does not send it.

If delivery reports an error, ask the agent to check `r3 worker status`. A sandbox warning may require `r3 worker restart` from a regular terminal outside the agent sandbox.

## A revision is missing

Choose **Go to the latest version**. Local file edits appear only after the agent publishes them.

If images or styles are missing, ask the agent to include them. External resources are blocked by default. Read the [permission prompt](/docs/permissions/) before allowing broader access.

## A target or context is missing

Use **Locate** to return to the original version. Ask the agent for a linked fix if the element changed. For a diff with missing surrounding lines, request a new publication with more context.

## Sign-in or editing stopped working

For local sign-in, run `r3 open` and use its fresh link. For remote access, check the server address and sign in again. **Restore** archived work before editing.

If the CLI and server disagree, update both. For other problems, [report an issue](https://github.com/hyperlogue/r3/issues) with the version and steps to reproduce; omit private content and credentials.
