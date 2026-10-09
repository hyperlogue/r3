Example Fieldwork sometimes creates two projects after a quick double click. The first patch disables the button while a request is running. Review what happens on both success and failure before calling the bug fixed.

<div class="scenario">
<div><strong>The work</strong><p>A captured diff for a project-creation form and its relevant tests.</p></div>
<div><strong>The review</strong><p>Does the fix prevent duplicate submissions without trapping the user after a failure?</p></div>
</div>

## Give the agent a concrete bug

> Read `r3 guide` and `r3 guide diff`. In the Example Fieldwork sample app, prevent duplicate project-creation requests while one submission is in flight. Keep validation and retry behavior usable. Make the change, test success and rejection, and publish the complete patch for review. Explain any server-side idempotency assumptions separately.

Use a disposable example app or a dedicated branch for the sample change. The example concerns the app under review; it does not ask r3 to apply a patch.

## Inspect the control flow

Open the diff and locate the submit handler. Check where the pending flag is set, whether every path clears it, and how the button state reflects it.

A recognizable failure is clearing the pending state only after a successful response:

```ts
setSubmitting(true);
await createProject(values);
setSubmitting(false);
```

If `createProject` rejects, the last line does not run. The form may remain disabled.

## Anchor the missing case

Select the new-side lines that clear the state and comment:

> If the request rejects, this never clears the pending flag. Restore the form after failure, keep the entered values, and show a useful error. Add a test that rejects once and then succeeds on retry.

Send the feedback. The original diff target records the version, file, side, and line range so the agent can inspect the exact patch you saw.

## Review the new patch

The next publication should contain the complete patch for the new round. Inspect the reply’s linked lines, including a `finally` path or equivalent cleanup and an error state that preserves the input.

Read the test rather than relying only on its name. It should demonstrate that a second click while pending does not start another request, and that retry after rejection does start a new one.

## Separate the guarantees

- The UI prevents overlapping local submissions.
- A rejected request leaves a usable retry path.
- Input values remain available after failure.
- Server behavior is stated explicitly; a disabled button alone does not provide end-to-end idempotency.

Resolve the thread after the patch and meaningful tests support the requested behavior. Ask for another revision if the agent fixes the disabled state but drops the user’s input.

## Reproduce the publication

From the sample repository, the agent can capture the current working-tree patch:

```sh
r3 create --kind diff --working \
  --title 'Example Fieldwork — prevent duplicate submissions'
```

For a prepared staged patch, use `--staged` instead. See [Publish diffs](/docs/agents/diff/) for the complete capture choices and independent-version semantics.
