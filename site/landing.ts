import { docs, groups, homeDescription, homeTitle, stories } from "./catalog.ts";
import { featureHighlights } from "./features.ts";
import { commonPrompt, commonResponse, promptExamples } from "./prompt-examples.ts";
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
<div class="workspace-example" data-workspace-example>
<div class="workspace-fallback">
${["light", "dark"]
  .map(
    (theme) => `<div class="workspace-${theme}">
<img class="workspace-desktop" src="/assets/fieldwork-${theme}.png" width="1240" height="740" loading="lazy" alt="The real r3 workspace showing Example Fieldwork’s project form and a thread about who can access a project.">
<img class="workspace-mobile" src="/assets/fieldwork-mobile-${theme}.png" width="390" height="740" loading="lazy" alt="The real r3 phone layout showing the same Example Fieldwork review.">
</div>`,
  )
  .join("")}
</div>
</div>
<figcaption>The real r3 interface, with fictional data. Compare the proposed fix, leave a comment, or resolve the thread.<br><a class="button workspace-demo" href="/example/index.html">Try the demo →</a></figcaption>
</figure>`;
}

export function home() {
  return `<div data-pagefind-body>
<section class="home-hero" id="intro">
<div class="container">
<div class="hero-grid">
<div>
<h1 data-pagefind-meta="title">${homeTitle}</h1>
<p class="hero-description">${homeDescription}</p>
</div>
${reviewDetail()}
</div>
${skillInstall("skill-install")}
${promptDemo()}
</div>${workflowExample()}</section>
${featureHighlights()}
<section class="possibilities-section" id="use-cases" aria-labelledby="use-cases-heading">
<div class="container">
<div class="section-heading">
<div>
<p class="eyebrow">One fictional project. Real ways to work.</p>
<h2 id="use-cases-heading">What can you make with r3?</h2>
</div>
<a class="text-link" href="/use-cases/">Explore all use cases →</a>
</div>
<div class="story-grid home-stories">${storyCards()}</div>
</div>
</section>
<section class="start-section container" aria-labelledby="start-heading">
<img src="/assets/favicon.svg" width="56" height="56" alt="">
<p class="eyebrow">Your next review starts here</p>
<h2 id="start-heading">${homeTitle}</h2>
<p>${homeDescription}</p>
${skillInstall("start-install")}
</section>
</div>`;
}

function skillInstall(id: string) {
  return `<div class="install-block" id="${id}">
<h2 class="install-label">Install the publishing skill</h2>
<pre class="install-command"><code><span class="command-runner">npx</span> skills add <span class="command-package">hyperlogue/r3</span> <span class="command-flag">--skill</span> <span class="command-skill">publish-artifacts-to-r3</span> <span class="command-flag">--global</span></code></pre>
<p class="install-alternative"><a href="/docs/get-started/#other-installation-methods">Other ways to install →</a></p>
</div>`;
}

function reviewDetail() {
  return `<figure class="hero-review" id="review-detail">
<div class="hero-review-crop">
${["light", "dark"].map((theme) => `<img class="review-${theme}" src="/assets/fieldwork-comment-${theme}.png" width="520" height="440" alt="A card in a UI component showcase, with its button selected and r3’s floating composer ready to add the comment: Increase the margin above this button to 16px.">`).join("")}
</div>
</figure>`;
}

function promptDemo() {
  const first = promptExamples[0];
  return `<section class="prompt-example" id="agent-prompt" aria-labelledby="prompt-heading" data-prompt-demo>
<h3 id="prompt-heading">Then ask your agent to make something.</h3>
<div class="claude-terminal">
<div class="claude-session">
<div class="prompt-scene" data-prompt-scene>
<div class="claude-prompt"><span aria-hidden="true">❯</span><div><p class="prompt-words"><span data-prompt-variable data-prompt-text>${first.prompt}</span>${promptExamples.map((example) => `<span class="prompt-measure" aria-hidden="true" data-pagefind-ignore>${example.prompt}</span>`).join("")}</p><p class="prompt-common" data-prompt-common>${commonPrompt}</p></div></div>
<div class="claude-response"><span aria-hidden="true">●</span><div><p class="prompt-words"><span data-prompt-variable data-prompt-response>${first.response}</span>${promptExamples.map((example) => `<span class="prompt-measure" aria-hidden="true" data-pagefind-ignore>${example.response}</span>`).join("")}</p><p class="prompt-common" data-prompt-common>${commonResponse}</p></div></div>
</div>
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
