Example Fieldwork’s search returns the right projects, but the ranking is difficult to explain. Ask your agent to make the explanation interactive so you can test your understanding with concrete inputs.

<div class="scenario">
<div><strong>The work</strong><p>A small HTML explanation with a query field, sample projects, and a visible ranking breakdown.</p></div>
<div><strong>The review</strong><p>Can you predict why one result appears above another?</p></div>
</div>

## Ask for a model you can inspect

> Read `r3 guide` and `r3 guide html`. Build an interactive explanation of a proposed search ranking for Example Fieldwork. Use a small, fictional project dataset. Show how title matches, description matches, and recency contribute to the score. Let me change the query and inspect each contribution. State that this is a proposed illustrative ranking, and include a static explanation of the formula and limitations. Publish it as an HTML artifact.

Keep the model small enough to understand. Do not ask the agent to connect to a real project database for this review.

## Make a prediction

Search for “launch.” Before looking at the score breakdown, decide which project you expect first. Compare a recent project that mentions launch in its description with an older project that includes it in the title.

Change one input at a time. A useful explanation keeps the dataset and score contributions visible so you can see which rule caused the order to change.

## Question the surprising result

Select the score breakdown or its explanation and comment:

> I cannot tell whether recency can outweigh an exact title match. Show the contribution of each factor with units or weights, and add one example where changing recency changes the order. Explain whether that is intentional.

Send the feedback. This asks the agent to expose an assumption and demonstrate it, rather than making the visualization more decorative.

## Test the revised explanation

Follow the reply to the new score breakdown. Repeat the original query and reproduce the ranking change described by the agent. Check that displayed totals match the stated formula.

Read the static explanation too. It should carry the key argument even if you do not move a slider. If the interactive display and prose disagree, target the mismatch in a follow-up reply.

## Know what you learned

- You can explain the ordering of the sample results.
- Each factor’s contribution is visible.
- At least one example shows a ranking tradeoff.
- The page distinguishes this proposed model from production behavior.

This walkthrough describes Example Fieldwork’s proposed search, not r3’s own [library search](/docs/library/). r3 is the place where the explanation is published and discussed.

## Reproduce the publication

```sh
r3 create --kind html --dir ./fieldwork-search \
  --title 'Example Fieldwork — search explained'
```

Bundle scripts and sample data locally. Use stable IDs for the explanation, formula, and score breakdown. For an existing interactive example, [try the curve lab in the live demo](/demo/).
