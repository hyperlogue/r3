import { docs, groups, stories } from "./catalog.ts";
import { promptExamples } from "./prompt-examples.ts";
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

export function workflowExample() {
  return `<figure class="workflow-figure container container-wide" id="fieldwork-workspace">
<div class="illustration-caption"><span><span class="status-dot"></span> A review in Example Fieldwork</span><a href="/example/index.html">Open the workspace ↗</a></div>
<div class="workspace-example" data-workspace-example>
<a class="workspace-fallback" href="/example/index.html" aria-label="Explore Example Fieldwork in the real r3 workspace">
${["light", "dark"]
  .map(
    (theme) => `<div class="workspace-${theme}">
<img class="workspace-desktop" src="/assets/fieldwork-${theme}.png" width="1240" height="740" loading="lazy" alt="The real r3 workspace showing Example Fieldwork’s project form and a thread about who can access a project.">
<img class="workspace-mobile" src="/assets/fieldwork-mobile-${theme}.png" width="390" height="740" loading="lazy" alt="The real r3 phone layout showing the same Example Fieldwork review.">
</div>`,
  )
  .join("")}
</a>
</div>
<figcaption>The real r3 interface, with fictional data. Compare the proposed fix, leave a comment, or resolve the thread.</figcaption>
</figure>`;
}

export function home() {
  return `<div data-pagefind-body>
<section class="home-hero" id="intro">
<div class="container">
<div class="hero-grid">
<div>
<p class="eyebrow">Render. Review. Refine.</p>
<h1 data-pagefind-meta="title">See the work.<br><em>Make it better.</em></h1>
<p class="hero-description">Point to a detail.<br>Give your agent a clear next step.</p>
</div>
${reviewDetail()}
</div>
${skillInstall("skill-install")}
${promptDemo()}
</div>${workflowExample()}</section>
<section class="loop-section container" aria-labelledby="loop-heading">
<div class="section-heading">
<div>
<p class="eyebrow">How it works</p>
<h2 id="loop-heading">Less guessing.<br>A clearer review loop.</h2>
</div>
<a class="text-link" href="/docs/review-loop/">How the review loop works →</a>
</div>
<ol class="loop-steps">
<li>
<span>01 / Render</span>
<div>
<h3>See the actual work.</h3>
<p>A working prototype, an interactive explanation, a document worth reading. Your agent publishes it and shares a link.</p>
</div>
</li>
<li>
<span>02 / Review</span>
<div>
<h3>Point to the change.</h3>
<p>Select an element, passage, code line, or image region. Add your feedback, then send the batch to your agent.</p>
</div>
</li>
<li>
<span>03 / Refine</span>
<div>
<h3>Keep the context.</h3>
<p>Open the next version and follow the agent’s replies to the fix. Your original comments stay with the work you reviewed.</p>
</div>
</li>
</ol>
</section>
<section class="possibilities-section" id="use-cases" aria-labelledby="use-cases-heading">
<div class="container">
<div class="section-heading">
<div>
<p class="eyebrow">One fictional project. Real ways to work.</p>
<h2 id="use-cases-heading">What will you make clearer?</h2>
</div>
<a class="text-link" href="/use-cases/">Explore all use cases →</a>
</div>
<div class="story-grid home-stories">${storyCards()}</div>
</div>
</section>
<section class="start-section container" aria-labelledby="start-heading">
<img src="/assets/favicon.svg" width="56" height="56" alt="">
<p class="eyebrow">Your next review starts here</p>
<h2 id="start-heading">Give your agent<br>a place to show its work.</h2>
<p>Install the publishing skill and ask your agent to share its work on r3. The skill handles setup; you bring the judgment.</p>
${skillInstall("start-install")}
<p class="install-alternative"><a href="/docs/get-started/#other-installation-methods">Other ways to install →</a></p>
</section>
</div>`;
}

function skillInstall(id: string) {
  return `<div class="install-block" id="${id}">
<h2 class="install-label">Install the publishing skill</h2>
<pre class="install-command"><code>npx skills add hyperlogue/r3 --skill publish-artifacts-to-r3 --global</code></pre>
</div>`;
}

function reviewDetail() {
  return `<figure class="hero-review" id="review-detail">
<a class="hero-review-crop" href="/example/index.html" aria-label="Open the r3 workspace to follow this feedback and its linked fix">
${["light", "dark"]
  .map(
    (theme) =>
      `<img class="review-${theme}" src="/assets/fieldwork-${theme}.png" width="3720" height="2220" alt="r3’s Discussion panel: a comment asks who can see a project; the agent replies with a linked fix and a Compare action.">`,
  )
  .join("")}
</a>
<figcaption>Feedback. A reply. A fix you can inspect.</figcaption>
</figure>`;
}

function promptDemo() {
  const first = promptExamples[0];
  return `<section class="prompt-example" id="agent-prompt" aria-labelledby="prompt-heading" data-prompt-demo>
<h3 id="prompt-heading">Then ask your agent to make something.</h3>
<div class="claude-terminal">
<div class="claude-terminal-bar"><span>Claude Code</span><span>Illustrative session</span></div>
<div class="claude-session">
<div class="claude-welcome"><span class="claude-mark" aria-hidden="true">✳</span><div><strong>Claude Code</strong><span>~/fieldwork</span></div></div>
<div class="prompt-scene" data-prompt-scene>
<div class="claude-prompt"><span aria-hidden="true">❯</span><p class="prompt-words"><span aria-hidden="true"><span data-typed-prompt>${first.prompt}</span><span class="prompt-cursor"></span></span>${promptExamples.map((example) => `<span class="prompt-measure" aria-hidden="true" data-pagefind-ignore>${example.prompt}</span>`).join("")}<span class="sr-only" data-readable-prompt>${first.prompt}</span></p></div>
<div class="claude-response"><span aria-hidden="true">●</span><p class="prompt-words"><span data-prompt-response>${first.response}</span>${promptExamples.map((example) => `<span class="prompt-measure" aria-hidden="true" data-pagefind-ignore>${example.response}</span>`).join("")}</p></div>
<div class="claude-publication"><span aria-hidden="true">↳</span><span data-prompt-title>${first.title}</span><span class="publication-ready">Ready for review</span></div>
</div>
<div class="claude-hint">? for shortcuts</div>
</div>
</div>
<div class="prompt-controls js-control" role="group" aria-label="Example prompts">
<div>${promptExamples.map((example, index) => `<button type="button" data-prompt-choice="${index}" aria-pressed="${index === 0}">${example.label}</button>`).join("")}</div>
<button class="prompt-play" type="button" data-prompt-play aria-label="Pause prompt animation" title="Pause animation"><svg class="pause-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg><svg class="play-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m7 4 14 8-14 8z"/></svg></button>
</div>
</section>`;
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
<a class="button primary" href="/docs/get-started/#install-the-skill">Install the skill →</a>
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
