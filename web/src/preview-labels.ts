import type { ArtifactKind } from "../../shared/artifacts.ts";
import type { PreviewDisplay } from "../../shared/preview-protocol.ts";
import { type AppMessageKey, getLocale, type Locale, languageTags, t } from "./i18n.ts";

export function previewLabels(
  kind: ArtifactKind,
  locale: Locale = getLocale(),
): NonNullable<PreviewDisplay["labels"]> {
  const label = (message: AppMessageKey) => t(message, { lng: languageTags[locale] });
  return {
    backToTop: kind === "html" ? label("previewLabels.backToTop") : undefined,
    openComment: label("previewLabels.openComment"),
    quoteInNote: label("common.quoteInNote"),
    addComment: label("thread.addComment"),
    commentHere: label("previewLabels.commentHere"),
    commentHereHint: label("previewLabels.commentHereSpace"),
    selectParent: label("previewLabels.selectParent"),
    selectChild: label("previewLabels.selectChild"),
    wholePage: label("previewLabels.wholePage"),
  };
}
