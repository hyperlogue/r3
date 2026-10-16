A small patch can fix one problem while leaving another behind. This change prevents duplicate project submissions with a pending flag. The review focuses on what happens when the request fails.

## Read the patch

Inspect the added guard and the lines that set and clear pending. On success, the form becomes available again. If the awaited request throws, execution never reaches the line that clears the flag.

<!-- visual: story-code-review-start -->

## Question the failure path

Select the affected lines and ask whether the user can retry without losing their inputs. The thread records the exact range on the new side of the patch, so the agent can inspect the failure path directly.

<!-- visual: story-code-review-feedback -->

## Follow the fix

Open the agent’s linked revision. The catch block shows a retry message, and finally clears pending after either outcome. The form values stay in place. Check those changes before deciding the thread is resolved.

<!-- visual: story-code-review-result -->

[Try this example →](/example/index.html?scene=code-review)

Real r3 screens. Fictional data and scripted replies.
