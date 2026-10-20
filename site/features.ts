import { h, type Locale, siteTranslator } from "./i18n.ts";
import { escapeHTML } from "./render.ts";
export function getFeatures(locale: Locale = "en") {
  const t = siteTranslator(locale);
  const features = [
    {
      id: "precise-feedback",
      duration: 18,
      title: t("features.preciseFeedback.title"),
      videoLabel: t("common.commentOnTheWorkSendItTo"),
      description: t("features.preciseFeedback.description"),
    },
    {
      id: "agent-replies",
      duration: 10,
      title: t("features.agentReplies.title"),
      videoLabel: t("common.followTheReplyKeepEveryVersionSilent"),
      description: t("features.agentReplies.description"),
    },
    {
      id: "inspect-fixes",
      duration: 10,
      title: t("features.inspectFixes.title"),
      videoLabel: t("common.seeTheFixSideBySideSilent"),
      description: t("features.inspectFixes.description"),
    },
    {
      id: "image-comments",
      duration: 11,
      title: t("features.imageComments.title"),
      videoLabel: t("common.attachImagesInCommentsSilentDemo11"),
      description: t("features.imageComments.description"),
    },
    {
      id: "video-comments",
      duration: 12,
      title: t("features.videoComments.title"),
      videoLabel: t("common.commentOnTheExactVideoFrameSilent"),
      description: t("features.videoComments.description"),
    },
  ] as const;

  return features;
}
export const features = getFeatures();
export function featureHighlights(locale: Locale = "en") {
  const features = getFeatures(locale);
  return `<section class="features-section container" id="features" aria-labelledby="features-heading">
<div class="section-heading"><div><h2 id="features-heading">${h("common.aClearerConversation", locale)}<br>${h("common.fromFirstVersionToFinishedWork", locale)}</h2></div></div>
<div class="feature-list">${features
    .map(
      (feature) => `<article class="feature-row" id="${feature.id}">
<div class="feature-copy"><h3>${escapeHTML(feature.title)}</h3><p>${escapeHTML(feature.description)}</p></div>
<figure class="feature-video">
<video controls playsinline preload="none" width="1600" height="1000" poster="/assets/videos/${feature.id}.jpg" aria-label="${escapeHTML(feature.videoLabel)}">
<source src="/assets/videos/${feature.id}.mp4" type="video/mp4">
<a href="/assets/videos/${feature.id}.mp4">${h("common.watchTheDemo", locale)}</a>.
</video>
</figure></article>`,
    )
    .join("")}</div></section>`;
}
