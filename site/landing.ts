import { getCatalog } from "./catalog.ts";
import { featureHighlights } from "./features.ts";
import { h, type Locale } from "./i18n.ts";
import { getPromptExamples } from "./prompt-examples.ts";
import { escapeHTML } from "./render.ts";
import { richText } from "./rich-text.tsx";
import { storyIllustration } from "./story-illustrations.ts";

export function storyCards(locale: Locale = "en") {
  const { stories } = getCatalog(locale);
  return stories
    .map(
      (story) =>
        `<a class="story-card story-${story.slug}" href="/use-cases/${story.slug}/">
${storyIllustration(story.slug, locale)}
<h3>${escapeHTML(story.category)}</h3>
<p class="story-subtitle">${escapeHTML(story.title)}</p>
<p class="story-description">${escapeHTML(story.description)}</p>
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
<div class="browser-address" data-no-i18n>${icon('<path d="M4 7h8m6 0h2M4 17h2m6 0h8"/><circle cx="15" cy="7" r="3"/><circle cx="9" cy="17" r="3"/>', "browser-site-controls")}<span>localhost:8891<span class="browser-url-path">/artifact_example</span></span>${icon('<path d="m12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.4L12 17.5l-5.7 3.1 1.1-6.4-4.6-4.5 6.4-.9Z"/>', "browser-bookmark")}</div>
${icon('<circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/>', "browser-menu")}
</div>
</div>`;
}

export function workflowExample(locale: Locale = "en") {
  const { promptExamples } = getPromptExamples(locale);
  return `<figure class="workflow-figure container" id="fieldwork-workspace">
<div class="browser-frame">
${browserBar(`<span data-workspace-label>${escapeHTML(promptExamples[0].label)}</span>`)}
<div class="workspace-example" data-workspace-example>
${promptExamples
  .map(
    (
      { scene, screenshotDescription, mobileScreenshotDescription },
      index,
    ) => `<div class="workspace-fallback" data-workspace-scene="${scene}" ${index ? "hidden" : ""}>
${["light", "dark"]
  .map((theme) => {
    const prefix = scene === "prototype" ? "fieldwork" : `fieldwork-${scene}`;
    return `<div class="workspace-${theme}">
<img class="workspace-desktop" src="/assets/${prefix}-${theme}.png" width="1240" height="740" loading="lazy" alt="${escapeHTML(screenshotDescription)}">
<img class="workspace-mobile" src="/assets/${prefix}-mobile-${theme}.png" width="390" height="740" loading="lazy" alt="${escapeHTML(mobileScreenshotDescription)}">
</div>`;
  })
  .join("")}
</div>`,
  )
  .join("")}
</div>
</div>
<figcaption><a class="button workspace-demo" href="/example/index.html?scene=prototype">${h("landing.tryTheDemo", locale)}</a></figcaption>
</figure>`;
}

export function home(locale: Locale = "en") {
  const { homeDescription, homeTitleLines } = getCatalog(locale);
  return `<div data-pagefind-body>
<section class="home-hero" id="intro">
<div class="container container-wide hero-grid">
<div class="hero-copy">
<h1 data-pagefind-meta="title">${homeTitleLines.map((line) => `<span class="hero-title-line">${escapeHTML(line)}</span>`).join(" ")}</h1>
<p class="hero-description">${escapeHTML(homeDescription)}</p>
</div>
${reviewDetail(locale)}
</div>
<div class="container">
${promptDemo(locale)}
</div>${workflowExample(locale)}
<div class="container">
${skillInstall("skill-install", locale)}
</div></section>
${featureHighlights(locale)}
<section class="possibilities-section" id="use-cases" aria-labelledby="use-cases-heading">
<div class="container">
<div class="section-heading">
<div>
<h2 id="use-cases-heading">${h("landing.seeTheIterationLoopInAction", locale)}</h2>
</div>
<a class="text-link" href="/use-cases/">${h("landing.exploreAllUseCases", locale)}</a>
</div>
<div class="story-grid home-stories">${storyCards(locale)}</div>
</div>
</section>
<section class="start-section container" aria-labelledby="start-heading">
<img src="/assets/favicon.svg" width="56" height="56" alt="">
<p class="eyebrow">${h("landing.startIteratingVisuallyWithYourAgent", locale)}</p>
<h2 id="start-heading">${homeTitleLines.map((line) => `<span class="hero-title-line">${escapeHTML(line)}</span>`).join(" ")}</h2>
${skillInstall("start-install", locale)}
</section>
</div>`;
}

function skillInstall(id: string, locale: Locale) {
  return `<div class="install-block" id="${id}">
<h2 class="install-label">${h("landing.installTheSkillToTryItWith", locale)}</h2>
<pre class="install-command"><code><span class="command-runner">npx</span> skills add <span class="command-package">hyperlogue/r3</span> <span class="command-flag">--skill</span> <span class="command-skill">publish-artifacts-to-r3</span> <span class="command-flag">--global</span></code></pre>
<p class="install-alternative"><a href="/docs/get-started/#other-installation-methods">${h("landing.otherWaysToInstall", locale)}</a></p>
</div>`;
}

function reviewDetail(locale: Locale = "en") {
  return `<figure class="hero-review" id="review-detail">
<div class="browser-frame hero-browser">
${browserBar(h("common.privacyDialogs", locale))}
<div class="hero-review-crop">
${["light", "dark"].map((theme) => `<img class="review-${theme}" src="/assets/fieldwork-privacy-${theme}.png" width="1240" height="660" alt="${h("landing.privacyDialogReview", locale)}">`).join("")}
</div>
</div>
</figure>`;
}

function promptDemo(locale: Locale = "en") {
  const { commonPrompt, commonResponse, promptExamples } = getPromptExamples(locale);
  const first = promptExamples[0];
  return `<section class="prompt-example" id="agent-prompt" aria-labelledby="prompt-heading" data-prompt-demo>
<h3 id="prompt-heading">${h("landing.askYourAgentToMakeSomething", locale)}</h3>
<div class="claude-terminal">
<div class="claude-session">
<div class="prompt-scene" data-prompt-scene>
<div class="claude-prompt"><span aria-hidden="true">❯</span><div><p class="prompt-words"><span data-prompt-variable data-prompt-text>${escapeHTML(first.prompt)}</span>${promptExamples.map((example) => `<span class="prompt-measure" aria-hidden="true" data-pagefind-ignore>${escapeHTML(example.prompt)}</span>`).join("")}</p><p class="prompt-common" data-prompt-common>${escapeHTML(commonPrompt)}</p></div></div>
<div class="claude-response"><span aria-hidden="true">●</span><div><p class="prompt-words"><span data-prompt-variable data-prompt-response>${escapeHTML(first.response)}</span>${promptExamples.map((example) => `<span class="prompt-measure" aria-hidden="true" data-pagefind-ignore>${escapeHTML(example.response)}</span>`).join("")}</p><p class="prompt-common" data-prompt-common>${escapeHTML(commonResponse)}</p></div></div>
</div>
</div>
</div>
<div class="prompt-controls js-control" role="group" aria-label="${h("landing.examplePrompts", locale)}">
<div>${promptExamples.map((example, index) => `<button type="button" data-prompt-choice="${index}" aria-pressed="${index === 0}">${escapeHTML(example.label)}</button>`).join("")}</div>
<button class="prompt-play" type="button" data-prompt-play aria-label="${h("common.pausePromptAnimation", locale)}" title="${h("common.pauseAnimation", locale)}"><svg class="pause-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg><svg class="play-icon" width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="m7 4 14 8-14 8z"/></svg></button>
</div>
</section>`;
}

export function useCases(locale: Locale = "en") {
  return `<div data-pagefind-body>
<header class="index-hero container">
<h1 data-pagefind-meta="title">${h("landing.oneProject", locale)}<br>
<em>${h("landing.fiveRealWorldIterations", locale)}</em>
</h1>
<p class="lede">${h("landing.followExampleFieldworkAFictionalProjectPlanning", locale)}</p>
</header>
<div class="container">
<div class="story-grid case-grid">${storyCards(locale)}</div>
<aside class="note-banner">
<strong>${h("landing.readItThenTryItWithYour", locale)}</strong>
<p>${h("landing.eachWalkthroughIncludesAStartingPromptWhat", locale)} <a href="/demo/">${h("landing.liveDemo", locale)}</a> ${h("landing.usesACurveLabAndCodeReview", locale)}</p>
</aside>
</div>
<section class="container story-principle">
<p class="eyebrow">${h("landing.aUsefulPatternToBorrow", locale)}</p>
<h2>${h("landing.pointToEvidence", locale)}<br>${h("landing.askForAConcreteChange", locale)}</h2>
<p>${h("landing.makeThisBetterStartsAnotherRoundOf", locale)}</p>
<a class="text-link" href="/docs/feedback/">${h("landing.learnToGivePreciseFeedback", locale)}</a>
</section>
</div>`;
}

export function searchPage(locale: Locale = "en") {
  return `<section class="search-page container">
<p class="eyebrow">${h("landing.findYourNextStep", locale)}</p>
<h1>${h("landing.searchTheDocs", locale)}</h1>
<form action="/search/" role="search" id="search-form">
<label for="search-input">${h("landing.searchFeaturesWorkflowsAndCommands", locale)}</label>
<div class="search-field">
<input id="search-input" type="search" name="q" placeholder="${h("landing.tryFeedbackVideoOrPublish", locale)}" autocomplete="off">
<button class="button primary" type="submit">${h("navigation.groups.search", locale)}</button>
</div>
</form>
<p id="search-status" role="status" aria-live="polite">${h("landing.searchRunsInYourBrowserNoQueries", locale)}</p>
<ol id="search-results" class="search-results">
</ol>
<noscript>
<p>${richText("landing.pSearchNeedsJavascriptYouCanBrowse", locale, { docs: "/docs/", text: "/llms-full.txt" })}</p>
</noscript>
<div class="search-suggestions">
<span>${h("landing.goodPlacesToStart", locale)}</span>
<a href="/docs/get-started/">${h("landing.getStarted", locale)}</a>
<a href="/docs/feedback/">${h("landing.preciseFeedback", locale)}</a>
<a href="/docs/agents/">${h("landing.agentWorkflow", locale)}</a>
</div>
</section>`;
}
