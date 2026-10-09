import { docs, groups, stories } from "./catalog.ts";
import { escapeHTML } from "./render.ts";

export function storyCards() {
  return stories
    .map(
      (story) =>
        `<a class="story-card story-${story.slug}" href="/use-cases/${story.slug}/">
<div class="story-card-top">
<span>${story.number} / ${story.category}</span>
<span aria-hidden="true">↗</span>
</div>
<h3>${story.title}</h3>
<p>${story.description}</p>
<span class="story-link">${story.name} <span aria-hidden="true">→</span>
</span>
</a>`,
    )
    .join("");
}

export function workflowIllustration() {
  return `<figure class="workflow-figure">
<div class="illustration-caption">
<span>
<span class="status-dot">
</span> A review in Example Fieldwork</span>
<span>Illustrated workflow</span>
</div>
<div class="review-window">
<div class="window-bar">
<div class="window-project">
<span class="mini-mark">r3</span>
<span>Project creation</span>
<span class="version-chip">Version 1</span>
</div>
<span class="window-feedback">Discussions <b>1</b>
</span>
</div>
<div class="review-panes">
<div class="fieldwork-preview">
<div class="fieldwork-nav">
<span class="fieldwork-logo">▧ <b>Fieldwork</b>
</span>
<span>Workspace / Projects</span>
</div>
<div class="fieldwork-form">
<span class="mini-eyebrow">A little room for your next big idea</span>
<h3>Start something good.</h3>
<p>Bring your people, plans, and progress together.</p>
<div class="illustrated-field">
<span>Project name</span>
<strong>Autumn launch</strong>
</div>
<div class="illustrated-field">
<span>Project description <small>Optional</small>
</span>
<strong>A calmer way to plan our next release.</strong>
</div>
<div class="selected-control">
<span>Visibility</span>
<strong>Workspace <span aria-hidden="true">⌄</span>
</strong>
<span class="anchor-pin">1</span>
</div>
<div class="illustrated-submit">Create project <span aria-hidden="true">↗</span>
</div>
</div>
<span class="selection-note">01 — Point at the part that needs work</span>
</div>
<div class="illustrated-thread">
<div class="thread-heading">
<span>Active</span>
<span>Resolved</span>
</div>
<div class="thread-content">
<div class="thread-byline">
<span class="avatar human">Y</span>
<b>You</b>
<span>on Visibility</span>
</div>
<blockquote>Who can see a workspace project? Explain this before I create it.</blockquote>
<div class="target-label">
<span class="anchor-pin">1</span> Visibility · Version 1</div>
<div class="thread-rule">
</div>
<div class="thread-byline">
<span class="avatar agent">a</span>
<b>Agent</b>
<span>Version 2</span>
</div>
<p>Added an explanation beneath the visibility setting. Your choice stays editable.</p>
<a class="fix-link" href="/use-cases/prototype/#review-the-revision">↗ Fix: Visibility explanation</a>
<div class="fixed-preview">
<span>Workspace</span>
<p>Everyone in your workspace can find and open this project.</p>
</div>
<span class="thread-footer">02 — Follow the reply to the fix</span>
</div>
</div>
</div>
</div>
<figcaption>One concrete comment. One traceable revision. You decide when it’s resolved.</figcaption>
</figure>`;
}

export function home() {
  return `<div data-pagefind-body>
<section class="home-hero container">
<p class="eyebrow">
<span class="status-dot">
</span> A workspace for you and your coding agent</p>
<div class="hero-grid">
<h1 data-pagefind-meta="title">See the work.<br>Point to the change.<br>
<em>Make it better.</em>
</h1>
<div class="hero-aside">
<p>Your agent can build more than a chat response. Open the page, read the proposal, inspect the code. Give feedback exactly where it belongs.</p>
<div class="actions">
<a class="button primary" href="/demo/">Try the live demo <span aria-hidden="true">↗</span>
</a>
<a class="text-link" href="/docs/get-started/">Get started →</a>
</div>
<p class="hero-footnote">Works with any agent that can run a command.<br>Runs locally. Yours to explore.</p>
</div>
</div>${workflowIllustration()}</section>
<section class="loop-section container" aria-labelledby="loop-heading">
<div class="section-intro">
<p class="eyebrow">Render. Review. Refine.</p>
<h2 id="loop-heading">A short loop.<br>A much clearer conversation.</h2>
<a class="text-link" href="/docs/review-loop/">How the review loop works →</a>
</div>
<ol class="loop-steps">
<li>
<span>01</span>
<div>
<h3>Ask for something you can use.</h3>
<p>A working prototype. An interactive explanation. A document worth reading. Your agent publishes it to r3 and shares a link.</p>
</div>
</li>
<li>
<span>02</span>
<div>
<h3>Put the feedback on the work.</h3>
<p>Select the element, passage, code line, or image region. Add your thought, then send the batch to your agent.</p>
</div>
</li>
<li>
<span>03</span>
<div>
<h3>See what changed. Keep the context.</h3>
<p>Open the new version and follow the agent’s replies to the fix. The original comment stays attached to what you actually reviewed.</p>
</div>
</li>
</ol>
</section>
<section class="possibilities-section">
<div class="container">
<div class="section-heading">
<div>
<p class="eyebrow">One fictional project. Real ways to work.</p>
<h2>What will you make clearer?</h2>
</div>
<a class="text-link" href="/use-cases/">Explore all use cases →</a>
</div>
<div class="story-grid">${storyCards()}</div>
</div>
</section>
<section class="surfaces-section container">
<div class="section-intro">
<p class="eyebrow">Different work. The same conversation.</p>
<h2>More than a preview.</h2>
<p>Use the representation that makes the work understandable. r3 keeps your feedback in that context.</p>
</div>
<div class="surface-list">
<a href="/docs/html/">
<span class="surface-icon">&lt;/&gt;</span>
<div>
<h3>Pages you can interact with</h3>
<p>Prototypes, dashboards, visual explanations, and small tools.</p>
</div>
<span aria-hidden="true">↗</span>
</a>
<a href="/docs/files/">
<span class="surface-icon">Aa</span>
<div>
<h3>Documents with room for detail</h3>
<p>Rendered Markdown, highlighted source, and supporting files.</p>
</div>
<span aria-hidden="true">↗</span>
</a>
<a href="/docs/diffs/">
<span class="surface-icon">±</span>
<div>
<h3>Code with the right context</h3>
<p>Old and new lines, captured context, and conversations on the patch.</p>
</div>
<span aria-hidden="true">↗</span>
</a>
<a href="/docs/media/">
<span class="surface-icon">▧</span>
<div>
<h3>Feedback on what you see</h3>
<p>Images, saved video frames, regions, and visual fix comparisons.</p>
</div>
<span aria-hidden="true">↗</span>
</a>
</div>
</section>
<section class="start-section container">
<div>
<p class="eyebrow">Your next review starts here</p>
<h2>Give your agent<br>a place to show its work.</h2>
<p>Install r3, then ask your agent to read <code>r3 guide</code>.<br>You bring the judgment. Your agent handles the commands.</p>
<a class="button primary" href="/docs/get-started/">Start your first review <span aria-hidden="true">↗</span>
</a>
</div>
<div class="terminal">
<div class="terminal-top">
<span>Install once</span>
<span>macOS / Linux</span>
</div>
<pre>
<code>npm install -g @hyperlogue/r3</code>
</pre>
<div class="terminal-prompt">
<span>Then ask your agent</span>
<p>“Read r3 guide. Build a prototype of our project-creation flow and publish it for review.”</p>
</div>
</div>
</section>
</div>`;
}

export function useCases() {
  return `<div data-pagefind-body>
<header class="index-hero container">
<p class="eyebrow">The Example Fieldwork series</p>
<h1 data-pagefind-meta="title">One project.<br>
<em>Five ways to work.</em>
</h1>
<p class="lede">Example Fieldwork is a fictional project-planning app. Follow it from a rough interface to a clearer launch, with one concrete review at a time.</p>
</header>
<div class="container">
<div class="story-grid case-grid">${storyCards()}</div>
<aside class="note-banner">
<strong>Read it. Then try it with your agent.</strong>
<p>Each walkthrough includes a starting prompt, what to inspect, example feedback, and a way to check the revision. The separate <a href="/demo/">live demo</a> uses a curve lab and code review with scripted agent replies.</p>
</aside>
</div>
<section class="container story-principle">
<p class="eyebrow">A useful pattern to borrow</p>
<h2>Point to evidence.<br>Ask for a concrete change.</h2>
<p>“Make this better” starts another round of guessing. “Explain who can see this project before I create it” gives your agent a target and a test.</p>
<a class="text-link" href="/docs/feedback/">Learn to give precise feedback →</a>
</section>
</div>`;
}

export function docsIndex() {
  return `<div data-pagefind-body>
<header class="index-hero container">
<p class="eyebrow">Documentation</p>
<h1 data-pagefind-meta="title">A little context.<br>
<em>A better review.</em>
</h1>
<p class="lede">Start with the workflow. Look up the details when you need them. Your agent can read the same docs.</p>
<div class="actions">
<a class="button primary" href="/docs/get-started/">Get started →</a>
<a class="text-link" href="/docs/agents/">Set up your agent ↗</a>
</div>
</header>
<div class="docs-directory container">${groups
    .map(
      (group, index) =>
        `<section>
<div>
<p class="eyebrow">0${index + 1}</p>
<h2>${group}</h2>
</div>
<div class="directory-links">${docs
          .filter((page) => page.group === group)
          .map(
            (page) =>
              `<a href="${page.path}">
<div>
<h3>${escapeHTML(page.title)}</h3>
<p>${escapeHTML(page.description)}</p>
</div>
<span aria-hidden="true">→</span>
</a>`,
          )
          .join("")}</div>
</section>`,
    )
    .join("")}</div>
<div class="container">
<aside class="note-banner">
<strong>Take these docs into your agent.</strong>
<p>Use <a href="/llms.txt">llms.txt</a> for the index or <a href="/llms-full.txt">llms-full.txt</a> for the complete text. Every article also has a Markdown version.</p>
</aside>
</div>
</div>`;
}

export function searchPage() {
  return `<section class="search-page container">
<p class="eyebrow">Find your next step</p>
<h1>Search the docs.</h1>
<form action="/search/" role="search" id="search-form">
<label for="search-input">Search features, workflows, and commands</label>
<div class="search-field">
<input id="search-input" type="search" name="q" placeholder="Try “feedback”, “video”, or “publish”…" autocomplete="off">
<button class="button primary" type="submit">Search</button>
</div>
</form>
<p id="search-status" role="status" aria-live="polite">Search runs in your browser. No queries are sent to an analytics service.</p>
<ol id="search-results" class="search-results">
</ol>
<noscript>
<p>Search needs JavaScript. You can browse the complete <a href="/docs/">documentation directory</a> or <a href="/llms-full.txt">read all docs as text</a>.</p>
</noscript>
<div class="search-suggestions">
<span>Good places to start</span>
<a href="/docs/get-started/">Get started →</a>
<a href="/docs/feedback/">Precise feedback →</a>
<a href="/docs/agents/">Agent workflow →</a>
</div>
</section>`;
}
