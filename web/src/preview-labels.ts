import type { PreviewDisplay } from "../../shared/preview-protocol.ts";
import { getLocale, type Locale, t } from "./i18n.ts";

export function previewLabels(locale: Locale = getLocale()): NonNullable<PreviewDisplay["labels"]> {
  const label = (message: string) => t(message, undefined, locale);
  return {
    openComment: label("Open comment"),
    quoteInNote: label("Quote in note"),
    addComment: label("Add comment"),
    commentHere: label("Comment here"),
    commentHereHint: label("Comment here (Space)"),
    selectParent: label("Select parent"),
    cancel: label("Cancel"),
  };
}
