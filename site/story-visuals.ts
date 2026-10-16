const stories = {
  prototype: [
    ["start", "Try a project-creation form before polishing it."],
    ["feedback", "Ask who can see a workspace project, right on the control."],
    ["result", "Compare the original with the clearer visibility explanation."],
  ],
  proposal: [
    ["start", "Read the proposal alongside its supporting research."],
    ["feedback", "Question the invitation step in the first-session sequence."],
    ["result", "The revision lets new users reach a useful dashboard alone."],
  ],
  explainer: [
    ["start", "Explore a search-ranking lesson in the browser."],
    ["feedback", "Ask to compare freshness with relevance."],
    ["result", "Turn up freshness. Recent launch notes rise to the top."],
  ],
  "code-review": [
    ["start", "Inspect the patch that prevents duplicate submissions."],
    ["feedback", "Point to the failure path: can the user retry?"],
    ["result", "Check the fix: clear pending, show an error, preserve inputs."],
  ],
  media: [
    ["image", "Select the date."],
    ["video", "Save the exact frame."],
    ["comparison", "Compare the revised contrast."],
  ],
};

export const storyVisuals: Record<string, () => string> = Object.fromEntries(
  Object.entries(stories).flatMap(([scene, steps]) =>
    steps.map(([step, caption]) => {
      const media = scene === "media";
      const file = media ? `fieldwork-media-${step}` : `fieldwork-story-${scene}-${step}`;
      return [
        `story-${scene}-${step}`,
        () => `<figure class="doc-figure doc-screenshot story-screenshot">
<div class="doc-capture">${["light", "dark"].map((theme) => `<a class="doc-${theme}" href="/assets/${file}-${theme}.png" aria-label="Open full-size screenshot: ${caption}"><img src="/assets/${file}-${theme}.png" width="${media ? 1000 : 1240}" height="${media ? 600 : scene === "code-review" ? (step === "start" ? 320 : 480) : 740}" alt="${caption}" loading="lazy"></a>`).join("\n")}</div>
<figcaption>${caption}</figcaption>
</figure>`,
      ];
    }),
  ),
);
