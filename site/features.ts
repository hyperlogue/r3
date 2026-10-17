export const features = [
  {
    id: "precise-feedback",
    duration: 18,
    title: "Comment on the work. Send it to your agent.",
    description:
      "Click a button, heading, or input and leave a note. Collect your feedback, then send it to your agent in one batch, with the exact element and viewport context.",
  },
  {
    id: "agent-replies",
    duration: 10,
    title: "Follow the reply. Keep every version.",
    description:
      "Your agent replies in the same thread and publishes revisions as new versions. Earlier versions stay available, so you can revisit the original and open the latest when you’re ready.",
  },
  {
    id: "inspect-fixes",
    duration: 10,
    title: "See the fix, side by side.",
    description:
      "Once your agent publishes a revision, open Compare from the reply. Check the original beside the fix to see whether it solves the problem.",
  },
  {
    id: "image-comments",
    duration: 11,
    title: "Attach images in comments.",
    description:
      "Attach screenshots, sketches, or design mockups directly to your feedback to show your agent the intended design.",
  },
  {
    id: "video-comments",
    duration: 12,
    title: "Comment on the exact video frame.",
    description:
      "Pause anywhere in a clip, highlight a region, and leave a note. The captured timestamp and still frame give your agent unambiguous visual context.",
  },
] as const;

export function featureHighlights() {
  return `<section class="features-section container" id="features" aria-labelledby="features-heading">
<div class="section-heading"><div><h2 id="features-heading">A clearer conversation.<br>From first version to finished work.</h2></div></div>
<div class="feature-list">${features
    .map(
      (feature) => `<article class="feature-row" id="${feature.id}">
<div class="feature-copy"><h3>${feature.title}</h3><p>${feature.description}</p></div>
<figure class="feature-video">
<video controls playsinline preload="none" width="1600" height="1000" poster="/assets/videos/${feature.id}.jpg" aria-label="${feature.title} Silent demo, ${feature.duration} seconds.">
<source src="/assets/videos/${feature.id}.mp4" type="video/mp4">
<a href="/assets/videos/${feature.id}.mp4">Watch the demo</a>.
</video>
</figure></article>`,
    )
    .join("")}</div></section>`;
}
