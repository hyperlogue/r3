import { h, type Locale, siteTranslator } from "./i18n.ts";
import { escapeHTML } from "./render.ts";
import { getStoryVisuals } from "./story-visuals.ts";
export function expandDocVisuals(source: string, locale: Locale = "en") {
  const t = siteTranslator(locale);
  // Authored concept diagrams and captures of the real workspace, kept apart
  // from the short task instructions so each page stays easy to maintain.
  function screenshot(file: string, caption: string, width = 1240, height = 740) {
    return `<figure class="doc-figure doc-screenshot">
<div class="doc-capture">
<img class="doc-light" src="/assets/${file}-light.png" width="${width}" height="${height}" alt="${escapeHTML(caption)}" loading="lazy">
<img class="doc-dark" src="/assets/${file}-dark.png" width="${width}" height="${height}" alt="${escapeHTML(caption)}" loading="lazy">
</div>
<figcaption>${escapeHTML(caption)}</figcaption>
</figure>`;
  }

  function diagram(content: string, caption: string, className = "") {
    return `<figure class="doc-figure doc-diagram ${className}">${content}<figcaption>${escapeHTML(caption)}</figcaption></figure>`;
  }

  const visuals: Record<string, () => string> = {
    ...getStoryVisuals(locale),
    "media-image": () =>
      screenshot("fieldwork-media-image", t("docVisuals.mediaImageCaption"), 1000, 600),
    "media-video": () =>
      screenshot("fieldwork-media-video", t("docVisuals.mediaVideoCaption"), 1000, 600),
    "media-comparison": () =>
      screenshot("fieldwork-media-comparison", t("docVisuals.mediaComparisonCaption"), 1000, 600),
    workspace: () => screenshot("fieldwork", t("docVisuals.tryThePublishedWorkThenDiscussIt")),
    explainer: () =>
      screenshot("fieldwork-explainer", t("docVisuals.aWorkingExplainerMoveTheSlidersThen")),
    feedback: () =>
      screenshot("fieldwork-comment", t("docVisuals.aSelectedButtonItsReviewThreadAnd"), 820, 540),
    revisions: () =>
      screenshot(
        "fieldwork-comparison",
        t("docVisuals.compareTheOriginalPublicationWithTheAgent"),
        1240,
        480,
      ),
    navigation: () => `<figure class="doc-figure doc-phone">
<div class="doc-capture">
<img class="doc-light" src="/assets/fieldwork-mobile-light.png" width="390" height="740" alt="${h("docVisuals.phoneLayoutWithContentAboveTheDiscussion", locale)}" loading="lazy">
<img class="doc-dark" src="/assets/fieldwork-mobile-dark.png" width="390" height="740" alt="${h("docVisuals.phoneLayoutWithContentAboveTheDiscussion", locale)}" loading="lazy">
</div>
<div><strong>${h("docVisuals.contentFirst", locale)}</strong><p>${h("docVisuals.tapTheDiscussionBarToReadReplies", locale)}</p><span aria-hidden="true">↙</span></div>
<figcaption>${h("docVisuals.theSameReviewWithADiscussionSheet", locale)}</figcaption>
</figure>`,
    loop: () =>
      diagram(
        `<ol class="doc-flow">
<li><span>${h("common.agent", locale)}</span><strong>${h("docVisuals.publish", locale)}</strong><small>${h("docVisuals.aVersionToExplore", locale)}</small></li>
<li><span>${h("common.you", locale)}</span><strong>${h("docVisuals.review", locale)}</strong><small>${h("docVisuals.pointAndComment", locale)}</small></li>
<li><span>${h("common.you", locale)}</span><strong>${h("docVisuals.send", locale)}</strong><small>${h("docVisuals.shareTheFeedback", locale)}</small></li>
<li><span>${h("common.agent", locale)}</span><strong>${h("docVisuals.revise", locale)}</strong><small>${h("docVisuals.publishAndReply", locale)}</small></li>
<li><span>${h("common.you", locale)}</span><strong>${h("common.check", locale)}</strong><small>${h("docVisuals.resolveOrContinue", locale)}</small></li>
</ol>`,
        t("docVisuals.keepTheWorkAndItsConversationTogether"),
      ),
    access: () =>
      diagram(
        `<div class="doc-map">
<div><span class="doc-symbol" aria-hidden="true">▣</span><strong>${h("docVisuals.yourBrowser", locale)}</strong><small>${h("docVisuals.reviewAndComment", locale)}</small></div>
<span class="doc-connector" aria-hidden="true">↔</span>
<div class="doc-map-focus"><span class="doc-symbol" aria-hidden="true">r3</span><strong>${h("docVisuals.yourWorkspace", locale)}</strong><small>${h("docVisuals.onYourMachineOrServer", locale)}</small></div>
<span class="doc-connector" aria-hidden="true">↔</span>
<div><span class="doc-symbol" aria-hidden="true">&gt;_</span><strong>${h("docVisuals.yourAgent", locale)}</strong><small>${h("docVisuals.publishAndRevise", locale)}</small></div>
</div>`,
        t("docVisuals.theBrowserAndAgentConnectToThe"),
      ),
    files: () =>
      diagram(
        `<div class="doc-file-map">
<div><span class="doc-diagram-label">${h("docVisuals.onePublication", locale)}</span><strong>${h("docVisuals.projectProposal", locale)}</strong>
<ul><li><code>proposal.md</code><span>${h("docVisuals.documentSource", locale)}</span></li><li><code>research.md</code><span>${h("docVisuals.supportingNotes", locale)}</span></li><li><code>flow.png</code><span>${h("docVisuals.imagePreview", locale)}</span></li></ul></div>
<div class="doc-paper"><span class="doc-diagram-label">proposal.md</span><strong>${h("docVisuals.projectVisibility", locale)}</strong><p>${h("docVisuals.aClearAudienceForEveryProject", locale)}</p><b>${h("docVisuals.proposedApproach", locale)}</b><i></i><i></i><i></i></div>
</div>`,
        t("docVisuals.keepTheProposalAndItsSupportingFiles"),
      ),
    diff: () =>
      diagram(
        `<div class="doc-diff">
<div><span class="doc-diagram-label">${h("docVisuals.old", locale)}</span><pre><code>async function submit() {
  await save(project);
}</code></pre></div>
<div><span class="doc-diagram-label">${h("common.new", locale)}</span><pre><code>async function submit() {
<span>+ if (pending) return;</span>
  await save(project);
}</code></pre></div>
</div><div class="doc-diagram-comment">${h("docVisuals.whatHappensAfterAFailedRequest", locale)}</div>`,
        t("docVisuals.selectTheRelevantLinesOnEitherSide"),
      ),
    media: () =>
      diagram(
        `<svg class="doc-media" viewBox="0 0 640 280" role="img" aria-label="${h("docVisuals.aPausedVideoFrameWithARegion", locale)}">
<rect x="18" y="12" width="604" height="216" rx="5" fill="var(--soft)"/>
<path d="m18 203 130-111 119 85 85-120 270 146v25H18Z" fill="var(--border)"/>
<circle cx="531" cy="64" r="23" fill="var(--accent)" opacity=".22"/>
<text x="51" y="68" class="doc-media-title">${h("docVisuals.meetFieldwork", locale)}</text>
<text x="51" y="96">${h("docVisuals.aLittleRoomForYourNextIdea", locale)}</text>
<rect x="410" y="149" width="177" height="50" fill="var(--surface)" stroke="var(--accent)" stroke-width="2"/>
<text x="435" y="180">${h("docVisuals.launchingOctober12", locale)}</text>
<path d="M30 257h580" stroke="var(--border)" stroke-width="4"/>
<path d="M30 257h197" stroke="var(--accent)" stroke-width="4"/>
<circle cx="227" cy="257" r="6" fill="var(--accent)"/>
<text x="282" y="263">${h("docVisuals.paused0012", locale)}</text>
</svg>`,
        t("docVisuals.pauseChooseARegionAndKeepThat"),
      ),
    library: () =>
      diagram(
        `<div class="doc-library"><div class="doc-search-example"><span aria-hidden="true">⌕</span> ${h("common.visibilityExplanation", locale)}</div>
<div class="doc-search-result"><span>${h("docVisuals.publishedContent", locale)}</span><strong>${h("docVisuals.projectVisibilityAccess", locale)}</strong><small>${h("docVisuals.version2DesignProposal", locale)}</small></div>
<div class="doc-search-result"><span>${h("docVisuals.conversation", locale)}</span><strong>${h("docVisuals.whoCanSeeAWorkspaceProject", locale)}</strong><small>${h("docVisuals.projectCreationReviewOpenThread", locale)}</small></div></div>`,
        t("docVisuals.oneSearchCanLeadToTheDocument"),
      ),
    projects: () =>
      diagram(
        `<div class="doc-project"><span class="doc-diagram-label">${h("docVisuals.project", locale)}</span><strong>${h("common.fieldwork", locale)}</strong><div><span>${h("docVisuals.uiPrototype", locale)}</span><span>${h("docVisuals.designProposal", locale)}</span><span>${h("stories.codeReview.category", locale)}</span></div></div>`,
        t("docVisuals.relatedArtifactsStayTogetherEachWithIts"),
      ),
    cleanup: () =>
      diagram(
        `<div class="doc-map doc-lifecycle">
<div><strong>${h("docVisuals.active", locale)}</strong><small>${h("docVisuals.reviewAndRevise", locale)}</small></div><span class="doc-connector" aria-hidden="true">↔</span>
<div><strong>${h("docVisuals.archived", locale)}</strong><small>${h("docVisuals.readOrRestore", locale)}</small></div><span class="doc-connector" aria-hidden="true">→</span>
<div><strong>${h("docVisuals.deleted", locale)}</strong><small>${h("docVisuals.permanentlyRemoved", locale)}</small></div></div>`,
        t("docVisuals.archivingIsReversibleDeletionRemovesTheWhole"),
      ),
    permissions: () =>
      diagram(
        `<div class="doc-permissions">
<div><span class="doc-diagram-label">${h("docVisuals.byDefault", locale)}</span><strong>${h("docVisuals.isolatedPreview", locale)}</strong><ul><li>${h("docVisuals.readsItsPublishedFiles", locale)}</li><li>${h("docVisuals.noR3Credentials", locale)}</li><li>${h("docVisuals.outsideNetworkBlocked", locale)}</li></ul></div>
<div><span class="doc-diagram-label">${h("docVisuals.yourChoice", locale)}</span><strong>${h("docVisuals.additionalAccess", locale)}</strong><ul><li>${h("docVisuals.externalNetworkExplicitGrant", locale)}</li><li>${h("docVisuals.cameraOrMicSeparateConsent", locale)}</li><li>${h("docVisuals.browserPermissionStillRequired", locale)}</li></ul></div>
</div>`,
        t("docVisuals.readPermissionRequestsBeforeLettingAPage"),
      ),
  };

  return source.replace(/<!-- visual: ([a-z-]+) -->/g, (_, name: string) => {
    const render = visuals[name];
    if (!render) throw new Error(`Unknown documentation visual: ${name}`);
    return `<div data-visual-i18n>${render()}</div>`;
  });
}
