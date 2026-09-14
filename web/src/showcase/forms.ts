// Opaque previews disallow native form submissions. The showcase's forms only
// update its in-memory demo; dispatch their local handlers without navigation.
function submit(form: HTMLFormElement, submitter?: HTMLButtonElement) {
  if (form.reportValidity())
    form.dispatchEvent(new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter }));
}

document.addEventListener("click", (event) => {
  if (event.defaultPrevented || !(event.target instanceof Element)) return;
  const button = event.target.closest("button");
  if (!button || button.type !== "submit" || !button.form || button.disabled) return;
  event.preventDefault();
  submit(button.form, button);
});
document.addEventListener(
  "keydown",
  (event) => {
    const field = event.target;
    if (
      event.key !== "Enter" ||
      (!event.metaKey && !event.ctrlKey) ||
      event.isComposing ||
      !(field instanceof HTMLTextAreaElement) ||
      !field.closest("[data-artifact-composer]") ||
      !field.form
    )
      return;
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) submit(field.form);
  },
  true,
);
