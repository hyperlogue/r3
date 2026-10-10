An artifact is one piece of work with a conversation around it. A version is a complete, immutable publication of that work. You can keep reviewing the same artifact through several revisions without losing what a comment originally referred to.

## 1. Render the work

Ask your agent for the form that makes the idea easiest to inspect. A page can demonstrate behavior; a document can explain a decision; a diff can show exactly which code changes.

The agent publishes the prepared content and shares a link. r3 stores the captured bytes. Editing a local file after publication does not change the version you are reading.

## 2. Review in context

Explore before commenting. Try the controls, read the proposal, or inspect the changed lines. Then choose a target and add your feedback.

> The visibility choice is ambiguous. Add one sentence explaining who can find and open this project.

That comment carries its original version and target. You can also add general feedback when the concern belongs to the whole artifact.

Drafts stay with their targets when you switch views. Submitted comments are retained in the conversation. Add several related comments before handing them off.

## 3. Send the batch

**Send to agent** notifies the agent through the selected subscription. The agent fetches pending comments and thread status changes. A notification prompts the agent to fetch; delivery is recorded only after the CLI successfully outputs and acknowledges that batch. Neither step proves that a model has processed it.

If no agent is subscribed, **Use in agent** gives you a command to run in your harness. You can bring the review to a new agent this way too.

## 4. Inspect the revision

The agent publishes a new version and replies to individual threads. When it can identify the fix precisely, its reply links to that location.

Your selected version stays pinned when another arrives. Use **Go to the latest version** when you are ready. This lets you finish examining the original without the page changing underneath you.

## 5. Decide what is done

Open the proposed fix and check the behavior or explanation. Reply if more work is needed. Resolve the thread when you are satisfied; reopen it if the concern returns.

Publishing and replying do not resolve threads automatically. Resolution belongs to the human reviewer.

When the work is finished, [archive the artifact](/docs/cleanup/). Its versions and conversations remain readable, and its subscriptions are cleared.
