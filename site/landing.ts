import { homeDescription, homeTitle, stories } from "./catalog.ts";
import { featureHighlights } from "./features.ts";
import { commonPrompt, commonResponse, promptExamples } from "./prompt-examples.ts";
import { storyIllustration } from "./story-illustrations.ts";

export function storyCards() {
  return stories
    .map(
      (story) =>
        `<a class="story-card story-${story.slug}" href="/use-cases/${story.slug}/">
${storyIllustration(story.slug)}
<h3>${story.category}</h3>
<p class="story-subtitle">${story.title}</p>
<p class="story-description">${story.description}</p>
</a>`,
    )
    .join("");
}

function browserBar(label: string) {
  const icon = (path: string, className = "") =>
    `<svg class="${className}" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
  return `<div class="browser-chrome" aria-hidden="true">
<div class="browser-tabs">
<span class="browser-window-controls"><i></i><i></i><i></i></span>
<div class="browser-tab"><img src="/assets/favicon.svg" width="15" height="15" alt=""><span>${label} · r3</span>${icon('<path d="m8 8 8 8m0-8-8 8"/>', "browser-tab-close")}</div>
${icon('<path d="M12 5v14M5 12h14"/>', "browser-new-tab")}
<span class="browser-tab-search">${icon('<path d="m8 10 4 4 4-4"/>')}</span>
</div>
<div class="browser-toolbar">
<span class="browser-navigation">${icon('<path d="m12 5-7 7 7 7M5 12h14"/>')}${icon('<path d="m12 5 7 7-7 7M5 12h14"/>', "browser-forward")}${icon('<path d="M20 7v5h-5M19 8a8 8 0 1 0 1 7"/>')}</span>
<div class="browser-address">${icon('<path d="M4 7h8m6 0h2M4 17h2m6 0h8"/><circle cx="15" cy="7" r="3"/><circle cx="9" cy="17" r="3"/>', "browser-site-controls")}<span>localhost:8891<span class="browser-url-path">/artifact_example</span></span>${icon('<path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.4L12 17.5l-5.7 3.1 1.1-6.4-4.6-4.5 6.4-.9Z"/>', "browser-bookmark")}</div>
${icon('<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>', "browser-menu")}
</div>
</div>`;
}

export function workflowExample() {
  return `<figure class="workflow-figure container" id="fieldwork-workspace">
<div class="browser-frame">
${browserBar("<span data-workspace-label>UI Prototype</span>")}
<div class="workspace-example" data-workspace-example>
${promptExamples
  .map(
    (
      { scene, label },
      index,
    ) => `<div class="workspace-fallback" data-workspace-scene="${scene}" ${index ? "hidden" : ""}>
${["light", "dark"]
  .map((theme) => {
    const prefix = scene === "prototype" ? "fieldwork" : `fieldwork-${scene}`;
    return `<div class="workspace-${theme}">
<img class="workspace-desktop" src="/assets/${prefix}-${theme}.png" width="1240" height="740" loading="lazy" alt="${label} in the real r3 workspace, with the agent’s revision and a linked feedback thread.">
<img class="workspace-mobile" src="/assets/${prefix}-mobile-${theme}.png" width="390" height="740" loading="lazy" alt="${label} in the real r3 phone layout.">
</div>`;
  })
  .join("")}
</div>`,
  )
  .join("")}
</div>
</div>
<figcaption><a class="button workspace-demo" href="/example/index.html?scene=prototype">Try the demo →</a></figcaption>
</figure>`;
}

export function home() {
  return `<div data-pagefind-body>
<section class="home-hero" id="intro">
<div class="container container-wide hero-grid">
<div>
<h1 data-pagefind-meta="title">${homeTitle}</h1>
<p class="hero-description">${homeDescription}</p>
</div>
${reviewDetail()}
</div>
<div class="container">
${promptDemo()}
</div>${workflowExample()}
<div class="container">
${skillInstall("skill-install")}
</div></section>
${featureHighlights()}
<section class="possibilities-section" id="use-cases" aria-labelledby="use-cases-heading">
<div class="container">
<div class="section-heading">
<div>
<h2 id="use-cases-heading">See the iteration loop in action</h2>
</div>
<a class="text-link" href="/use-cases/">Explore all use cases →</a>
</div>
<div class="story-grid home-stories">${storyCards()}</div>
</div>
</section>
<section class="start-section container" aria-labelledby="start-heading">
<img src="/assets/favicon.svg" width="56" height="56" alt="">
<p class="eyebrow">Start iterating with your agent</p>
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
<div class="browser-frame hero-browser">
${browserBar("UI component showcase")}
<div class="hero-review-crop">
${["light", "dark"].map((theme) => `<img class="review-${theme}" src="/assets/fieldwork-comment-${theme}.png" width="820" height="540" alt="The r3 navbar above a highlighted button and its review thread: the user requests a 16px button margin, the agent confirms the change, and a draft asks to decrease the margin back to 8px.">`).join("")}
</div>
</div>
</figure>`;
}

function promptDemo() {
  const first = promptExamples[0];
  return `<section class="prompt-example" id="agent-prompt" aria-labelledby="prompt-heading" data-prompt-demo>
<h3 id="prompt-heading">Ask your agent to draft something.</h3>
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
<h1 data-pagefind-meta="title">One project.<br>
<em>Five real-world iterations.</em>
</h1>
<p class="lede">Follow Example Fieldwork—a fictional project-planning app—from early prototype to launch. Five concrete walkthroughs show how to explore, comment, and iterate with your agent.</p>
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
