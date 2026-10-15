export const features = [
  {
    id: "precise-feedback",
    title: "Comment right on the element.",
    description:
      "Click any button, heading, or input and leave your note. Your agent gets the exact DOM node and viewport context, so you never have to write paragraphs describing where to look.",
    scene: `<div class="mock-note"><span class="mock-label">HTML artifact / selected element</span><div class="mock-selection">Visibility <strong>Workspace⌄</strong></div><div class="mock-comment">Explain who can see this project.<span>Comment attached to Visibility <b>↗</b></span></div></div>`,
  },
  {
    id: "agent-handoff",
    title: "Send comments directly to the agent.",
    description:
      "Batch your feedback into a review queue and hand it off in one shot. Your agent picks up the tasks, addresses each comment, and replies directly in the thread.",
    scene: `<div class="mock-handoff"><span class="mock-label">Ready for your agent</span><p><span>01</span>Explain project visibility<i>✓</i></p><p><span>02</span>Make the next step clearer<i>✓</i></p><p><span>03</span>Shorten the introduction<i>✓</i></p><strong>Send to agent <span>3 comments →</span></strong></div>`,
  },
  {
    id: "inspect-fixes",
    title: "See the fix, side by side.",
    description:
      "When your agent replies with a fix, open the comparison view. See the original beside the revision to verify whether the change actually solved the problem.",
    scene: `<div class="mock-compare"><span class="mock-label">Original <span>Proposed fix</span></span><div><p>Visibility<strong>Workspace⌄</strong></p><p>Visibility<strong>Workspace⌄</strong><small>Everyone in your workspace can find and open this project.</small></p></div><span class="mock-reply">✓ Added an explanation <b>Compare ↗</b></span></div>`,
  },
  {
    id: "image-comments",
    title: "Support images in comments.",
    description:
      "Attach screenshots, sketches, or design mockups directly to your feedback. When words get messy, show your agent the target design.",
    scene: `<div class="mock-image-note"><span class="mock-label">A reference, right in the conversation</span><div class="mock-comment">Give the form more breathing room, like this.<div class="mock-attachment"><svg viewBox="0 0 180 112" fill="none"><rect width="180" height="112" rx="4" fill="#e9e5fa"/><rect x="34" y="12" width="112" height="88" rx="4" fill="#fff"/><rect x="46" y="24" width="50" height="5" rx="2" fill="#544482"/><rect x="46" y="39" width="88" height="14" rx="2" stroke="#d1c9e7"/><rect x="46" y="61" width="88" height="14" rx="2" stroke="#d1c9e7"/><rect x="98" y="83" width="36" height="7" rx="3" fill="#7561b3"/></svg><span>layout-reference.png<small>Image attached</small></span></div><span>Image + comment <b>↗</b></span></div></div>`,
  },
  {
    id: "video-comments",
    title: "Comment on the exact video frame.",
    description:
      "Pause anywhere in a clip, highlight a region, and leave a note. The captured timestamp and still frame give your agent unambiguous visual context.",
    scene: `<div class="mock-video-note"><span class="mock-label">Launch video / saved frame</span><div class="mock-video-frame"><div class="mock-frame-heading">Make room<br>for your next idea.<i></i></div><span class="mock-frame-time">00:12 / 00:30</span></div><div class="mock-comment">Hold this title a little longer.<span>Attached to frame at 00:12 <b>↗</b></span></div></div>`,
  },
] as const;

export function featureHighlights() {
  return `<section class="features-section container" id="features" aria-labelledby="features-heading">
<div class="section-heading"><div><h2 id="features-heading">A clearer conversation.<br>From first version to finished work.</h2></div></div>
<div class="feature-list">${features
    .map(
      (feature) => `<article class="feature-row" id="${feature.id}">
<div class="feature-copy"><h3>${feature.title}</h3><p>${feature.description}</p></div>
<div class="feature-video" role="img" aria-label="Video mockup: ${feature.title}">
<div class="mock-scene" aria-hidden="true">${feature.scene}</div>
<div class="mock-player" aria-hidden="true"><span class="mock-play">▶</span><span class="mock-timeline"></span><span>Video mockup</span><svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor"><path d="M6 2H2v4m8-4h4v4M2 10v4h4m8-4v4h-4"/></svg></div>
</div></article>`,
    )
    .join("")}</div></section>`;
}
