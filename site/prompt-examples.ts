export const promptExamples = [
  {
    label: "Prototype",
    prompt:
      "Build an HTML prototype of a project-creation form. Publish it to r3 so I can review the visibility settings.",
    response: "I’ll build the form and share an HTML artifact in r3 for your review.",
    title: "Project creation",
  },
  {
    label: "Explainer",
    prompt:
      "Make an interactive HTML explainer of how search ranking works. Add sliders I can try, then publish it to r3 for feedback.",
    response: "I’ll make the ranking explorable and publish the HTML artifact to r3.",
    title: "How search works",
  },
  {
    label: "Brief",
    prompt:
      "Write an HTML brief comparing three onboarding flows. Show the tradeoffs side by side and publish it to r3 so I can leave comments.",
    response: "I’ll lay out the options in an HTML artifact and share it in r3 for review.",
    title: "Choose an onboarding flow",
  },
] as const;
