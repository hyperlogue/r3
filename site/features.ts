export const features = [
  {
    id: "precise-feedback",
    duration: 20,
    title: "Comment right on the element.",
    description:
      "Click any button, heading, or input and leave your note. Your agent gets the exact DOM node and viewport context, so you never have to write paragraphs describing where to look.",
  },
  {
    id: "agent-handoff",
    duration: 20,
    title: "Send comments directly to the agent.",
    description:
      "Batch your feedback into a review queue and hand it off in one shot. Your agent picks up the tasks, addresses each comment, and replies directly in the thread.",
  },
  {
    id: "inspect-fixes",
    duration: 18,
    title: "See the fix, side by side.",
    description:
      "When your agent replies with a fix, open the comparison view. See the original beside the revision to verify whether the change actually solved the problem.",
  },
  {
    id: "image-comments",
    duration: 20,
    title: "Support images in comments.",
    description:
      "Attach screenshots, sketches, or design mockups directly to your feedback. When words get messy, show your agent the target design.",
  },
  {
    id: "video-comments",
    duration: 22,
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
<video controls playsinline preload="none" width="1600" height="1000" poster="/assets/videos/${feature.id}.jpg" aria-label="${feature.title}" aria-describedby="${feature.id}-caption">
<source src="/assets/videos/${feature.id}.mp4" type="video/mp4">
<a href="/assets/videos/${feature.id}.mp4">Watch the demo</a>.
</video>
<figcaption id="${feature.id}-caption"><span>0:${feature.duration} · Silent demo</span><a href="/assets/videos/${feature.id}.transcript.txt" aria-label="Read transcript: ${feature.title}">Read transcript ↗</a></figcaption>
</figure></article>`,
    )
    .join("")}</div></section>`;
}
