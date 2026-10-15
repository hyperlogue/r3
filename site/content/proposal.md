Example Fieldwork’s onboarding proposal says new users should “create a workspace, configure the defaults, and invite their team.” It does not explain who must do those tasks or what happens before the first invitation. Review the proposal as a decision document.

<div class="scenario">
<div><strong>The work</strong><p>A rendered Markdown proposal, supporting research notes, and a short checklist.</p></div>
<div><strong>The review</strong><p>Can a reader understand the first useful action and the evidence behind it?</p></div>
</div>

## Ask for the proposal and its evidence

> Read `r3 guide` and `r3 guide files`. Prepare an onboarding proposal for Example Fieldwork. Put the main recommendation in `proposal.md`, assumptions and fictional interview notes in `research-notes.md`, and the suggested first-run steps in `checklist.md`. Clearly label invented research as illustrative. Publish the directory as a files artifact.

Separating assumptions from actual evidence is critical—your agent shouldn't blur fictional user interviews with verified data.

## Read the proposed first run

Open the rendered proposal, click through supporting file links, and check `checklist.md` in the sidebar. You're looking for clear answers to three basics: who performs the setup, what they create first, and when they see real value.

If the proposal jumps straight from account creation to inviting teammates, highlight that passage.

## Ask for a decision, not more prose

> This sequence requires inviting teammates before the user has anything useful to show them. Propose a solo first-run path that creates one real project before the invitation step. Explain the tradeoff and update the checklist to match.

Leave this as a focused comment directly on the passage. Keep separate critiques in their own threads so your agent can address them independently.

## Check the whole publication

The agent will publish a revised directory snapshot. Open the agent’s reply, inspect the updated proposal, and confirm that the checklist matches the new sequence.

A realistic revised flow: name a project, add the first milestone, view the populated dashboard, and only then invite teammates. The rationale should explain why this gives the user immediate momentum and what administrative setup can wait.

## Resolve the decision

- The first useful action is explicit.
- The proposal distinguishes assumptions from research.
- The checklist matches the recommendation.
- The tradeoff is visible, including what remains untested.

If your agent merely rewords the prose without altering the actual sequence, keep the thread open. Resolve it once the proposal and its supporting files tell the same clear story.

## Reproduce the publication

```sh
r3 create --kind files --dir ./fieldwork-onboarding \
  --title 'Example Fieldwork — onboarding proposal'
```

Use a files artifact so the reviewer can browse all three documents. A later files version is a complete snapshot, not a patch; the agent must include every file still needed. See [Documents & files](/docs/files/) for view and navigation details.
