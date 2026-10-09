Start with `r3 status` to identify the instance and URL you are using. Then follow the symptom below.

## The agent did not receive my feedback

Check whether the workspace shows a listener. If it does not, use **Use in agent** and run the copied fetch command inside the harness. Copying is not delivery.

A successful queue notification can wait for the agent session to resume. A failed send remains visible; it does not silently acknowledge the pending feedback. Fetch it directly if you need to continue immediately.

Supported publications establish a publisher fallback through the local worker and selected backend. Explicit listen/watch takes priority. Use `r3 worker status` to inspect connection or delivery problems, and `r3 login` if that backend needs renewed authorization. An unsupported agent can use `r3 watch`. The [agent guide](/docs/agents/) explains subscription behavior and exit codes.

## The page did not update after a revision

The selected version stays pinned. Choose **Go to the latest version** or use the version selector. Local file changes do not affect a published version until the agent publishes again.

If the page itself is incomplete, ask the agent to confirm that all referenced assets were included in this version. Publications do not inherit missing files from earlier versions.

## The preview is blocked or missing resources

Read the preview protection message. A browser that cannot verify the default network boundary needs compatibility consent before authored content loads. See [Preview permissions](/docs/permissions/) for what each choice means.

External fonts, scripts, and API calls are blocked by default. Prefer a self-contained publication. Do not move a protected endpoint outside its guards to make a preview load.

For remote instances, check the public URL, allowed hostnames, HTTPS forwarding, and proxy coverage of `/__r3_preview/`.

## Locate cannot find an element

Return to the original version and route. A later page may have removed or renamed the element, or its content may depend on interaction state. The conversation and original evidence remain available.

Ask the agent for a verified fix target. Stable HTML IDs help, but an agent should not guess a selector or infer source lines from a rendered selection.

## A diff has no more context

r3 can show only the lines captured in the publication. The server does not read the agent’s live repository. Ask for a new patch with the context you need, or a separate files artifact with the surrounding source.

## Publication reports a conflict

Another version or lifecycle change may have arrived while the agent was preparing its update. Have the agent inspect the latest state before publishing again. For an uncertain-response retry, it must reuse the same captured bytes, expected sequence, retry key, and metadata.

## Login stopped working

Browser login tokens expire after the configured inactivity period or can be revoked. Obtain a fresh browser token through your authorized administration path. For CLI access, run `r3 login` against the intended backend. API keys and browser-approved CLI grants are separate from browser login tokens.

Check `R3_URL`, the nearest `.r3.json`, and the user `backendUrl` setting. A remote URL does not inherit credentials from another backend. The CLI reports malformed selected configuration rather than silently choosing a different instance.

## A comment conflicts after archive

Archived artifacts remain readable, but further conversation changes are closed until restore. Keep the prepared comment text, restore the artifact when continued work is intended, and try again. Restore does not revive the old subscription automatically.

## An old installation will not upgrade

Direct upgrades from the retired live-review store require r3 1.5.0 first. Current startup upgrades artifact schemas. Preserve your data and follow the supported upgrade path instead of pointing a test instance at the normal database.

For a reproducible product issue, use the project’s [issue tracker](https://github.com/hyperlogue/r3/issues). Include the r3 version and a minimal description, with credentials, private content, and machine identifiers removed.
