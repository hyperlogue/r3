export const commonPrompt = "Publish an HTML artifact to r3.";
export const commonResponse =
  "The artifact can be viewed at http://localhost:8891/artifact_example.";

export const promptExamples = [
  {
    label: "UI Prototype",
    scene: "prototype",
    prompt: "Build a project-creation form so I can review the visibility settings.",
    response: "Created a working prototype with project details and visibility controls.",
  },
  {
    label: "Explainer",
    scene: "explainer",
    prompt: "Explain how search ranking works with interactive sliders I can try.",
    response: "Created an interactive explainer with adjustable ranking signals.",
  },
  {
    label: "Design doc",
    scene: "brief",
    prompt: "Compare three onboarding flows and show their tradeoffs side by side.",
    response: "Created a comparison brief covering each flow’s strengths and tradeoffs.",
  },
] as const;

export type PromptScene = (typeof promptExamples)[number]["scene"];
