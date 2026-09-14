import { keysSuspended } from "./keys.ts";

export function artifactComposerField(id: string): HTMLTextAreaElement | null {
  const fields = document.querySelectorAll<HTMLTextAreaElement>(
    `[data-artifact-composer="${CSS.escape(id)}"]:not([data-reply-to]) textarea`,
  );
  return (
    [...fields].find(
      (field) => !field.disabled && !field.closest("[inert]") && field.getClientRects().length > 0,
    ) ?? null
  );
}

export function focusArtifactComposer(id: string): boolean {
  if (keysSuspended()) return false;
  const field = artifactComposerField(id);
  if (!field) return false;
  field.focus({ preventScroll: true });
  field.setSelectionRange(field.value.length, field.value.length);
  return true;
}
