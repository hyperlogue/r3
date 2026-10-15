// Authored concept diagrams and captures of the real workspace, kept apart
// from the short task instructions so each page stays easy to maintain.
function screenshot(file: string, caption: string, width = 1240, height = 740) {
  return `<figure class="doc-figure doc-screenshot">
<div class="doc-capture">
<img class="doc-light" src="/assets/${file}-light.png" width="${width}" height="${height}" alt="${caption}" loading="lazy">
<img class="doc-dark" src="/assets/${file}-dark.png" width="${width}" height="${height}" alt="${caption}" loading="lazy">
</div>
<figcaption>${caption}</figcaption>
</figure>`;
}

function diagram(content: string, caption: string, className = "") {
  return `<figure class="doc-figure doc-diagram ${className}">${content}<figcaption>${caption}</figcaption></figure>`;
}

const visuals: Record<string, () => string> = {
  "media-image": () =>
    screenshot(
      "fieldwork-media-image",
      "The selected date stays attached to the feedback and the agent’s reply.",
      1000,
      600,
    ),
  "media-video": () =>
    screenshot(
      "fieldwork-media-video",
      "A comment on the video at 00:02 keeps the exact frame and selected region.",
      1000,
      600,
    ),
  "media-comparison": () =>
    screenshot(
      "fieldwork-media-comparison",
      "Original and revised: the date now sits on a darker background.",
      1000,
      600,
    ),
  workspace: () =>
    screenshot("fieldwork", "Try the published work, then discuss it alongside the page."),
  explainer: () =>
    screenshot(
      "fieldwork-explainer",
      "A working explainer: move the sliders, then ask about the result.",
    ),
  feedback: () =>
    screenshot(
      "fieldwork-comment",
      "A selected button, its review thread, and a reply in progress.",
      820,
      540,
    ),
  revisions: () =>
    screenshot(
      "fieldwork-comparison",
      "Compare the original publication with the agent’s linked fix.",
      1240,
      480,
    ),
  navigation: () => `<figure class="doc-figure doc-phone">
<div class="doc-capture">
<img class="doc-light" src="/assets/fieldwork-mobile-light.png" width="390" height="740" alt="Phone layout with content above the Discussion bar" loading="lazy">
<img class="doc-dark" src="/assets/fieldwork-mobile-dark.png" width="390" height="740" alt="Phone layout with content above the Discussion bar" loading="lazy">
</div>
<div><strong>Content first.</strong><p>Tap the Discussion bar to read replies and leave feedback.</p><span aria-hidden="true">↙</span></div>
<figcaption>The same review, with a discussion sheet on your phone.</figcaption>
</figure>`,
  loop: () =>
    diagram(
      `<ol class="doc-flow">
<li><span>Agent</span><strong>Publish</strong><small>A version to explore</small></li>
<li><span>You</span><strong>Review</strong><small>Point and comment</small></li>
<li><span>You</span><strong>Send</strong><small>Share the feedback</small></li>
<li><span>Agent</span><strong>Revise</strong><small>Publish and reply</small></li>
<li><span>You</span><strong>Check</strong><small>Resolve or continue</small></li>
</ol>`,
      "Keep the work and its conversation together through every revision.",
    ),
  access: () =>
    diagram(
      `<div class="doc-map">
<div><span class="doc-symbol" aria-hidden="true">▣</span><strong>Your browser</strong><small>Review and comment</small></div>
<span class="doc-connector" aria-hidden="true">↔</span>
<div class="doc-map-focus"><span class="doc-symbol" aria-hidden="true">r3</span><strong>Your workspace</strong><small>On your machine or server</small></div>
<span class="doc-connector" aria-hidden="true">↔</span>
<div><span class="doc-symbol" aria-hidden="true">&gt;_</span><strong>Your agent</strong><small>Publish and revise</small></div>
</div>`,
      "The browser and agent connect to the same workspace.",
    ),
  files: () =>
    diagram(
      `<div class="doc-file-map">
<div><span class="doc-diagram-label">One publication</span><strong>Project proposal</strong>
<ul><li><code>proposal.md</code><span>Document ↔ Source</span></li><li><code>research.md</code><span>Supporting notes</span></li><li><code>flow.png</code><span>Image preview</span></li></ul></div>
<div class="doc-paper"><span class="doc-diagram-label">proposal.md</span><strong>Project visibility</strong><p>A clear audience for every project.</p><b>Proposed approach</b><i></i><i></i><i></i></div>
</div>`,
      "Keep the proposal and its supporting files in one review.",
    ),
  diff: () =>
    diagram(
      `<div class="doc-diff">
<div><span class="doc-diagram-label">Old</span><pre><code>async function submit() {
  await save(project);
}</code></pre></div>
<div><span class="doc-diagram-label">New</span><pre><code>async function submit() {
<span>+ if (pending) return;</span>
  await save(project);
}</code></pre></div>
</div><div class="doc-diagram-comment">“What happens after a failed request?”</div>`,
      "Select the relevant lines on either side. Illustration of a code review.",
    ),
  media: () =>
    diagram(
      `<svg class="doc-media" viewBox="0 0 640 280" role="img" aria-label="A paused video frame with a region around the launch date">
<rect x="18" y="12" width="604" height="216" rx="5" fill="var(--soft)"/>
<path d="m18 203 130-111 119 85 85-120 270 146v25H18Z" fill="var(--border)"/>
<circle cx="531" cy="64" r="23" fill="var(--accent)" opacity=".22"/>
<text x="51" y="68" class="doc-media-title">Meet Fieldwork.</text>
<text x="51" y="96">A little room for your next idea.</text>
<rect x="410" y="149" width="177" height="50" fill="var(--surface)" stroke="var(--accent)" stroke-width="2"/>
<text x="435" y="180">Launching October 12</text>
<path d="M30 257h580" stroke="var(--border)" stroke-width="4"/>
<path d="M30 257h197" stroke="var(--accent)" stroke-width="4"/>
<circle cx="227" cy="257" r="6" fill="var(--accent)"/>
<text x="282" y="263">Paused · 00:12</text>
</svg>`,
      "Pause, choose a region, and keep that frame with your comment. Illustration.",
    ),
  library: () =>
    diagram(
      `<div class="doc-library"><div class="doc-search-example"><span aria-hidden="true">⌕</span> visibility explanation</div>
<div class="doc-search-result"><span>Published content</span><strong>Project visibility &amp; access</strong><small>Version 2 · Design proposal</small></div>
<div class="doc-search-result"><span>Conversation</span><strong>“Who can see a workspace project?”</strong><small>Project-creation review · Open thread</small></div></div>`,
      "One search can lead to the document or the conversation. Illustrative results.",
    ),
  projects: () =>
    diagram(
      `<div class="doc-project"><span class="doc-diagram-label">Project</span><strong>Fieldwork</strong><div><span>UI prototype</span><span>Design proposal</span><span>Code review</span></div></div>`,
      "Related artifacts stay together, each with its own versions and discussion.",
    ),
  cleanup: () =>
    diagram(
      `<div class="doc-map doc-lifecycle">
<div><strong>Active</strong><small>Review and revise</small></div><span class="doc-connector" aria-hidden="true">↔</span>
<div><strong>Archived</strong><small>Read or restore</small></div><span class="doc-connector" aria-hidden="true">→</span>
<div><strong>Deleted</strong><small>Permanently removed</small></div></div>`,
      "Archiving is reversible. Deletion removes the whole review.",
    ),
  permissions: () =>
    diagram(
      `<div class="doc-permissions">
<div><span class="doc-diagram-label">By default</span><strong>Isolated preview</strong><ul><li>Reads its published files</li><li>No r3 credentials</li><li>Outside network blocked</li></ul></div>
<div><span class="doc-diagram-label">Your choice</span><strong>Additional access</strong><ul><li>External network: explicit grant</li><li>Camera or mic: separate consent</li><li>Browser permission still required</li></ul></div>
</div>`,
      "Read permission requests before letting a page reach beyond its publication.",
    ),
};

export function expandDocVisuals(source: string) {
  return source.replace(/<!-- visual: ([a-z-]+) -->/g, (_, name: string) => {
    const render = visuals[name];
    if (!render) throw new Error(`Unknown documentation visual: ${name}`);
    return render();
  });
}
