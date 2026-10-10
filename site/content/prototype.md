Example Fieldwork helps small teams plan projects. Its first project-creation screen has all the right controls, but the visibility setting is hard to interpret. Review the behavior before investing in the final design.

<div class="scenario">
<div><strong>The work</strong><p>An interactive HTML prototype with a name, description, and visibility setting.</p></div>
<div><strong>The review</strong><p>Can someone create a project and understand who will be able to see it?</p></div>
</div>

## Give your agent a starting point

After [installing r3](/docs/get-started/), ask:

> Read `r3 guide` and `r3 guide html`. Build a self-contained HTML prototype for Example Fieldwork, a fictional project-planning app. The new-project form needs a required name, optional description, and private/workspace visibility. Include validation and a confirmation state. Use fictional data, local assets, and stable IDs for review targets. Publish it to r3 and share the URL.

The agent prepares a directory with `index.html` and all required assets, then publishes an HTML artifact. You open its link and interact with the result.

## Try the flow

Enter “Autumn launch” as the project name. Leave the description blank to check that optional really means optional. Try submitting an empty name and confirm the validation explains how to recover.

Then inspect visibility. Does “Workspace” mean every member, invited collaborators, or a public link? Can you answer before pressing Create?

## Point to the uncertainty

Turn on comment mode and select the visibility control. Add:

> Who can see a workspace project? Explain this before I create it. Make the private choice equally clear, and keep my selection editable.

Send the feedback to your agent. The target preserves the selected element and publication. A good revision should address the decision, not simply replace “Workspace” with another unexplained term.

## Review the revision

When the agent replies, open the new version and its fix link. An example improvement is a sentence beneath the control:

> Everyone in your workspace can find and open this project.

That is example product copy, not a claim about r3’s own access model. Example Fieldwork is the application being designed inside the review.

If the original and reply have supported rendered-element targets, use **Compare** to inspect them together. Then interact with the new form and switch between private and workspace to check both explanations.

## Decide whether it is done

- The visibility choices explain their audience before creation.
- The form preserves the selection while you edit other fields.
- The confirmation agrees with what you selected.
- The explanation and controls remain readable on a phone.

Resolve the thread after checking these outcomes. If only one choice is explained, reply in the same thread and ask for the missing case.

## Reproduce the publication

The agent can use a prepared directory such as `./fieldwork-prototype`:

```sh
r3 create --kind html --dir ./fieldwork-prototype \
  --title 'Example Fieldwork — project creation'
```

After making the change, it publishes the complete directory to the returned artifact ID. The [HTML guide](/docs/agents/html/) covers stable targets and named fix links.

For immediate practice, [open the Example Fieldwork workspace](/example/index.html). It starts on the revised form with the agent’s fix selected. Use **Compare** or the version selector to inspect the original, then try commenting and resolving the thread in the real r3 interface. The data and agent replies are fictional; reset returns to the sample.

The separate [live demo](/demo/) includes a curve lab and code review with scripted agent replies.
