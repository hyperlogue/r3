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
    prompt: "Write a design doc for project visibility, including access rules and tradeoffs.",
    response: "Created a design proposal with the access model, tradeoffs, and rollout plan.",
  },
] as const;

export type PromptScene = (typeof promptExamples)[number]["scene"];
