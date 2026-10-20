import { type Locale, siteTranslator } from "./i18n.ts";
export function getPromptExamples(locale: Locale = "en") {
  const t = siteTranslator(locale);
  const commonPrompt = t("prompts.instruction");
  const commonResponse = t("common.theArtifactCanBeViewedAtHttp");

  const promptExamples = [
    {
      label: t("prompts.prototype.label"),
      scene: "prototype",
      screenshotDescription: t("common.uiPrototypeInTheRealR3Workspace"),
      mobileScreenshotDescription: t("common.uiPrototypeInTheRealR3Phone"),
      prompt: t("prompts.prototype.prompt"),
      response: t("prompts.prototype.response"),
    },
    {
      label: t("prompts.explainer.label"),
      scene: "explainer",
      screenshotDescription: t("common.explainerInTheRealR3WorkspaceWith"),
      mobileScreenshotDescription: t("common.explainerInTheRealR3PhoneLayout"),
      prompt: t("prompts.explainer.prompt"),
      response: t("prompts.explainer.response"),
    },
    {
      label: t("prompts.brief.label"),
      scene: "brief",
      screenshotDescription: t("common.designDocInTheRealR3Workspace"),
      mobileScreenshotDescription: t("common.designDocInTheRealR3Phone"),
      prompt: t("prompts.brief.prompt"),
      response: t("prompts.brief.response"),
    },
  ] as const;

  return { commonPrompt, commonResponse, promptExamples };
}
export const { commonPrompt, commonResponse, promptExamples } = getPromptExamples();
export type PromptScene = (typeof promptExamples)[number]["scene"];
