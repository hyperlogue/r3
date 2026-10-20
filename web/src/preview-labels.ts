import type { PreviewDisplay } from "../../shared/preview-protocol.ts";
import { type AppMessageKey, getLocale, type Locale, languageTags, t } from "./i18n.ts";

export function previewLabels(locale: Locale = getLocale()): NonNullable<PreviewDisplay["labels"]> {
  const label = (message: AppMessageKey) => t(message, { lng: languageTags[locale] });
  return {
    openComment: label("previewLabels.openComment"),
    quoteInNote: label("common.quoteInNote"),
    addComment: label("thread.addComment"),
    commentHere: label("previewLabels.commentHere"),
    commentHereHint: label("previewLabels.commentHereSpace"),
    selectParent: label("previewLabels.selectParent"),
    cancel: label("common.cancel"),
  };
}
