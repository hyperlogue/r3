export const features = [
  {
    id: "precise-feedback",
    title: "Point to exactly what you mean.",
    description:
      "Select an element, a passage, a code line, or a moment in a video. Your comment stays attached to the detail your agent needs to change.",
    scene: `<div class="mock-note"><span class="mock-label">HTML artifact / selected element</span><div class="mock-selection">Visibility <strong>Workspace⌄</strong></div><div class="mock-comment">Explain who can see this project.<span>Comment attached to Visibility <b>↗</b></span></div></div>`,
  },
  {
    id: "version-history",
    title: "Every revision keeps its context.",
    description:
      "Each publication saves a complete version of the work. Open an earlier revision and see the comments against what you actually reviewed.",
    scene: `<div class="mock-versions"><span class="mock-label">Project creation</span><div><span>v1</span><p>First draft<small>Original feedback preserved</small></p><i>○</i></div><div class="mock-current"><span>v2</span><p>Clearer visibility<small>New version, same conversation</small></p><i>✓</i></div></div>`,
  },
  {
    id: "inspect-fixes",
    title: "Follow the reply to the fix.",
    description:
      "Your agent can link its reply to the change in a new version. Compare the original with the proposed fix, then decide when the thread is resolved.",
    scene: `<div class="mock-compare"><span class="mock-label">Original <span>Proposed fix</span></span><div><p>Visibility<strong>Workspace⌄</strong></p><p>Visibility<strong>Workspace⌄</strong><small>Everyone in your workspace can find and open this project.</small></p></div><span class="mock-reply">✓ Added an explanation <b>Compare ↗</b></span></div>`,
  },
  {
    id: "agent-handoff",
    title: "Send a whole round of feedback.",
    description:
      "Keep reviewing without interrupting your agent after every thought. Collect your comments, send them together, and continue in the same conversation.",
    scene: `<div class="mock-handoff"><span class="mock-label">Your feedback</span><p><span>01</span>Explain project visibility<i>✓</i></p><p><span>02</span>Make the next step clearer<i>✓</i></p><p><span>03</span>Shorten the introduction<i>✓</i></p><strong>Send to agent <span>3 comments →</span></strong></div>`,
  },
  {
    id: "review-surfaces",
    title: "Bring more than a screenshot.",
    description:
      "Try a working HTML page, read a document, inspect a code diff, or review images and video. Each has a view and comment targets suited to the work.",
    scene: `<div class="mock-surfaces"><span class="mock-label">One place to review your agent’s work</span><div><span><b>⌘</b>Interactive pages</span><span><b>¶</b>Documents</span><span><b>±</b>Code changes</span><span><b>▧</b>Images &amp; video</span></div></div>`,
  },
] as const;

export function featureHighlights() {
  return `<section class="features-section container" id="features" aria-labelledby="features-heading">
<div class="section-heading"><div><p class="eyebrow">Made for working together</p><h2 id="features-heading">A clearer conversation.<br>From first draft to finished work.</h2></div></div>
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
