import { type Locale, siteTranslator } from "./i18n.ts";
import { escapeHTML } from "./render.ts";
export function getStoryVisuals(locale: Locale = "en") {
  const t = siteTranslator(locale);
  const stories = {
    prototype: [
      [
        "start",
        t("storyVisuals.tryAProjectCreationFormBeforePolishing"),
        t("common.openFullSizeScreenshotTryAProject"),
      ],
      [
        "feedback",
        t("storyVisuals.askWhoCanSeeAWorkspaceProject"),
        t("common.openFullSizeScreenshotAskWhoCan"),
      ],
      [
        "result",
        t("storyVisuals.compareTheOriginalWithTheClearerVisibility"),
        t("common.openFullSizeScreenshotCompareTheOriginal"),
      ],
    ],
    proposal: [
      [
        "start",
        t("storyVisuals.readTheProposalAlongsideItsSupportingResearch"),
        t("common.openFullSizeScreenshotReadTheProposal"),
      ],
      [
        "feedback",
        t("storyVisuals.questionTheInvitationStepInTheFirst"),
        t("common.openFullSizeScreenshotQuestionTheInvitation"),
      ],
      [
        "result",
        t("storyVisuals.theRevisionLetsNewUsersReachA"),
        t("common.openFullSizeScreenshotTheRevisionLets"),
      ],
    ],
    explainer: [
      [
        "start",
        t("storyVisuals.exploreASearchRankingLessonInThe"),
        t("common.openFullSizeScreenshotExploreASearch"),
      ],
      [
        "feedback",
        t("storyVisuals.askToCompareFreshnessWithRelevance"),
        t("common.openFullSizeScreenshotAskToCompare"),
      ],
      [
        "result",
        t("storyVisuals.turnUpFreshnessRecentLaunchNotesRise"),
        t("common.openFullSizeScreenshotTurnUpFreshness"),
      ],
    ],
    "code-review": [
      [
        "start",
        t("storyVisuals.inspectThePatchThatPreventsDuplicateSubmissions"),
        t("common.openFullSizeScreenshotInspectThePatch"),
      ],
      [
        "feedback",
        t("storyVisuals.pointToTheFailurePathCanThe"),
        t("common.openFullSizeScreenshotPointToThe"),
      ],
      [
        "result",
        t("storyVisuals.checkTheFixClearPendingShowAn"),
        t("common.openFullSizeScreenshotCheckTheFix"),
      ],
    ],
    media: [
      ["image", t("storyVisuals.selectTheDate"), t("common.openFullSizeScreenshotSelectTheDate")],
      [
        "video",
        t("storyVisuals.saveTheExactFrame"),
        t("common.openFullSizeScreenshotSaveTheExact"),
      ],
      [
        "comparison",
        t("storyVisuals.compareTheRevisedContrast"),
        t("common.openFullSizeScreenshotCompareTheRevised"),
      ],
    ],
  };

  const storyVisuals: Record<string, () => string> = Object.fromEntries(
    Object.entries(stories).flatMap(([scene, steps]) =>
      steps.map(([step, caption, fullSizeLabel]) => {
        const media = scene === "media";
        const file = media ? `fieldwork-media-${step}` : `fieldwork-story-${scene}-${step}`;
        return [
          `story-${scene}-${step}`,
          () => `<figure class="doc-figure doc-screenshot story-screenshot">
<div class="doc-capture">${["light", "dark"].map((theme) => `<a class="doc-${theme}" href="/assets/${file}-${theme}.png" aria-label="${escapeHTML(fullSizeLabel)}"><img src="/assets/${file}-${theme}.png" width="${media ? 1000 : 1240}" height="${media ? 600 : scene === "code-review" ? (step === "start" ? 320 : 480) : 740}" alt="${escapeHTML(caption)}" loading="lazy"></a>`).join("\n")}</div>
<figcaption>${escapeHTML(caption)}</figcaption>
</figure>`,
        ];
      }),
    ),
  );

  return storyVisuals;
}
