Example Fieldwork’s onboarding proposal says new users should “create a workspace, configure the defaults, and invite their team.” It does not explain who must do those tasks or what happens before the first invitation. Review the proposal as a decision document.

<div class="scenario">
<div><strong>The work</strong><p>A rendered Markdown proposal, supporting research notes, and a short checklist.</p></div>
<div><strong>The review</strong><p>Can a reader understand the first useful action and the evidence behind it?</p></div>
</div>

## Ask for the proposal and its evidence

> Read `r3 guide` and `r3 guide files`. Prepare an onboarding proposal for Example Fieldwork. Put the main recommendation in `proposal.md`, assumptions and fictional interview notes in `research-notes.md`, and the suggested first-run steps in `checklist.md`. Clearly label invented research as illustrative. Publish the directory as a files artifact.

The distinction between evidence and assumption matters. The agent should not present a fictional interview as a real user study.

## Read the proposed first run

Open the rendered proposal. Follow its supporting-file links, and use the file panel to check the checklist. Look for an explicit answer to three questions: who starts, what they create, and when they get a useful result.

If the proposal jumps straight from account creation to invitations, select that passage.

## Ask for a decision, not more prose

> This sequence requires inviting teammates before the user has anything useful to show them. Propose a solo first-run path that creates one real project before the invitation step. Explain the tradeoff and update the checklist to match.

Send this as one concern anchored to the passage. Add a separate note only if the supporting research has an independent problem.

## Check the whole publication

The agent should publish a complete revised directory. Open its reply and inspect the new proposal, then verify that the checklist reflects the same order.

An example revised sequence is: name a project, add the first milestone, see the project overview, then invite a teammate. The rationale should explain why this gives the user something concrete to share and what collaboration setup is deferred.

## Resolve the decision

- The first useful action is explicit.
- The proposal distinguishes assumptions from research.
- The checklist matches the recommendation.
- The tradeoff is visible, including what remains untested.

Keep the thread open if the agent only rewrites the sentence without changing the proposed flow. Resolve once the decision and its supporting files agree.

## Reproduce the publication

```sh
r3 create --kind files --dir ./fieldwork-onboarding \
  --title 'Example Fieldwork — onboarding proposal'
```

Use a files artifact so the reviewer can browse all three documents. A later files version is a complete snapshot, not a patch; the agent must include every file still needed. See [Documents & files](/docs/files/) for view and navigation details.
