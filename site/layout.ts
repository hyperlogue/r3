import { groups, navigationDocs, type Page, stories } from "./catalog.ts";
import { escapeHTML, type Heading } from "./render.ts";

function githubLink(id: string) {
  return `<a id="${id}" class="github-link" href="https://github.com/hyperlogue/r3" aria-label="GitHub repository" title="GitHub repository">
<svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" focusable="false"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.65 7.65 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
</a>`;
}

function nav(current: string) {
  return groups
    .map(
      (group) =>
        `<div class="nav-group">
<p>${escapeHTML(group)}</p>${navigationDocs
          .filter((page) => page.group === group)
          .map(
            (page) =>
              `<a href="${page.path}"${page.path === (current === "/docs/" ? "/docs/get-started/" : current) ? ' aria-current="page"' : ""}>${escapeHTML(page.title)}</a>`,
          )
          .join("")}</div>`,
    )
    .join("");
}

export function shell(
  page: Page,
  body: string,
  options: {
    base: string;
    origin: string;
    headings?: Heading[];
    article?: boolean;
    markdown?: boolean;
  },
) {
  const { base, origin, headings = [], article = false, markdown = true } = options;
  const isDoc = page.path.startsWith("/docs/");
  const isCase = page.path.startsWith("/use-cases/") && page.path !== "/use-cases/";
  const currentStory = isCase
    ? stories.find((s) => `/use-cases/${s.slug}/` === page.path)
    : undefined;
  const eyebrow = isCase
    ? `<a href="/use-cases/" class="breadcrumb-link">Use cases</a> / ${escapeHTML(currentStory ? `${currentStory.number} ${currentStory.category}` : page.group)}`
    : escapeHTML(page.group);
  const markdownPath = `${page.path}index.md`;
  const canonicalPath = page.canonicalPath ?? page.path;
  const links = `<a href="/use-cases/"${page.path.startsWith("/use-cases/") ? ' aria-current="page"' : ""}>Use cases</a>
<a href="/docs/"${page.path.startsWith("/docs/") ? ' aria-current="page"' : ""}>Docs</a>`;
  const themeScript = `(()=>{let t=new URLSearchParams(location.search).get('theme');try{t||=localStorage.getItem('r3-site-theme')}catch{}document.documentElement.dataset.theme=t==='light'||t==='dark'?t:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'})()`;
  const toc = headings.length
    ? `<nav class="toc" aria-label="On this page">
<p>On this page</p>${headings.map((h) => `<a href="#${h.id}">${escapeHTML(h.text)}</a>`).join("")}</nav>`
    : "";
  const tools = markdown
    ? `<div class="article-tools">
<button type="button" data-markdown="${markdownPath}" class="js-control">Copy as Markdown</button>
<a href="${markdownPath}">View Markdown <span aria-hidden="true">↗</span>
</a>
</div>`
    : "";
  const articleBody = `<article class="article${isCase ? " visual-story" : ""}" data-pagefind-body>
<header class="article-header">
<p class="eyebrow" data-pagefind-meta="section">${eyebrow}</p>
<h1 data-pagefind-meta="title">${escapeHTML(page.title)}</h1>
<p class="lede">${escapeHTML(page.description)}</p>${isCase ? "" : tools}</header>
<div class="prose">${body}</div>${isCase ? tools : ""}${articleEnd(page)}</article>`;
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHTML(page.title)} · r3</title>
<meta name="description" content="${escapeHTML(page.description)}">
<link rel="canonical" href="${escapeHTML(origin + canonicalPath)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="r3">
<meta property="og:title" content="${escapeHTML(page.title)}">
<meta property="og:description" content="${escapeHTML(page.description)}">
<meta property="og:url" content="${escapeHTML(origin + canonicalPath)}">
<meta property="og:image" content="${escapeHTML(origin)}/assets/social.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/r3-theme.css">
<link rel="stylesheet" href="/assets/site.css">
<script>${themeScript}</script>
<script type="module" src="/assets/site.js">
</script>
</head>
<body data-base="${escapeHTML(base)}">
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
<div class="container container-wide header-content">
<div class="brand">
<span data-site-logo><img src="/assets/favicon.svg" width="32" height="32" alt=""></span>
<a class="brand-name" href="/" aria-label="r3 home">r3</a>
</div>
<nav class="desktop-nav" aria-label="Main navigation">${links}</nav>
<div class="header-actions">
<a class="search-link" href="/search/" aria-label="Search documentation">
<span aria-hidden="true">
<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6">
<circle cx="10.5" cy="10.5" r="6.5"/>
<path d="m16 16 5 5"/>
</svg>
</span>
<span>Search</span>
<kbd>/</kbd>
</a>
<button class="theme-toggle js-control" type="button" aria-label="Switch color theme" title="Switch color theme">
<svg class="theme-sun" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/></svg>
<svg class="theme-moon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M20.5 14A9 9 0 0 1 10 3.5 9 9 0 1 0 20.5 14Z"/></svg>
</button>
${githubLink("header-github")}
<a class="button primary small header-start" href="/docs/get-started/#install-the-skill">Install the skill <span aria-hidden="true">→</span>
</a>
<details class="mobile-menu">
<summary aria-label="Open navigation">Menu</summary>
<nav aria-label="Mobile navigation">${links}<a href="/docs/get-started/#install-the-skill">Install the skill</a>
</nav>
</details>
</div>
</div>
</header>${
    isDoc
      ? `<div class="docs-shell">
<aside class="docs-sidebar">
<nav aria-label="Documentation">${nav(page.path)}</nav>
<a class="agent-link" href="/docs/agents/">For your agent <span>r3 guide ↗</span>
</a>
</aside>
<div class="doc-content">
<details class="mobile-docs">
<summary>Browse documentation</summary>
<nav aria-label="Documentation">${nav(page.path)}</nav>
</details>
<main id="main">${articleBody}</main>
</div>
<aside class="toc-column">${toc}</aside>
</div>`
      : `<main id="main" class="${article ? `story-layout${isCase ? " visual-story-layout" : ""}` : ""}">${article ? `${articleBody}${isCase ? "" : `<aside class="toc-column">${toc}</aside>`}` : body}</main>`
  }<footer id="site-footer" class="site-footer">
<a class="brand" href="/">
<span class="brand-name">r3</span>
</a>
<nav aria-label="Footer">
<a href="/docs/get-started/">Get started</a>
<a href="/docs/agents/">For agents</a>
<a href="/llms.txt">llms.txt</a>
${githubLink("footer-github")}
</nav>
</footer>
<div class="toast" role="status" aria-live="polite">
</div>
</body>
</html>`;
}

function articleEnd(page: Page) {
  if (page.path.startsWith("/use-cases/")) {
    const storyIndex = stories.findIndex((s) => `/use-cases/${s.slug}/` === page.path);
    if (storyIndex >= 0) {
      const prev = storyIndex > 0 ? stories[storyIndex - 1] : undefined;
      const next = storyIndex < stories.length - 1 ? stories[storyIndex + 1] : undefined;
      return `<nav class="article-next" aria-label="Next steps">
${prev ? `<a href="/use-cases/${prev.slug}/">← ${prev.number} ${escapeHTML(prev.name)}</a>` : `<a href="/use-cases/">← All walkthroughs</a>`}
${next ? `<a href="/use-cases/${next.slug}/">${next.number} ${escapeHTML(next.name)} →</a>` : `<a href="/docs/get-started/">Try it with your agent →</a>`}
</nav>`;
    }
    return `<nav class="article-next" aria-label="Next steps">
<a href="/use-cases/">← All five walkthroughs</a>
<a href="/docs/get-started/">Try it with your agent →</a>
</nav>`;
  }
  const index = navigationDocs.findIndex(
    (p) => p.path === (page.path === "/docs/" ? "/docs/get-started/" : page.path),
  );
  const next = index >= 0 ? navigationDocs[index + 1] : undefined;
  return next
    ? `<nav class="article-next" aria-label="Next page">
<span>Keep reading</span>
<a href="${next.path}">${escapeHTML(next.title)} →</a>
</nav>`
    : "";
}
