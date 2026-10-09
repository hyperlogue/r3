import { docs, groups, type Page } from "./catalog.ts";
import { escapeHTML, type Heading } from "./render.ts";

function nav(current: string) {
  return groups
    .map(
      (group) =>
        `<div class="nav-group">
<p>${escapeHTML(group)}</p>${docs
          .filter((page) => page.group === group)
          .map(
            (page) =>
              `<a href="${page.path}"${page.path === current ? ' aria-current="page"' : ""}>${escapeHTML(page.title)}</a>`,
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
  const isDoc = page.path.startsWith("/docs/") && page.path !== "/docs/";
  const markdownPath = `${page.path}index.md`;
  const links = `<a href="/use-cases/"${page.path.startsWith("/use-cases/") ? ' aria-current="page"' : ""}>Use cases</a>
<a href="/docs/"${page.path.startsWith("/docs/") ? ' aria-current="page"' : ""}>Docs</a>
<a href="/demo/">Live demo <span aria-hidden="true">↗</span>
</a>`;
  const themeScript = `try{const t=localStorage.getItem('r3-site-theme');document.documentElement.dataset.theme=t==='light'||t==='dark'?t:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'}catch{}`;
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
  const articleBody = `<article class="article" data-pagefind-body>
<header class="article-header">
<p class="eyebrow" data-pagefind-meta="section">${escapeHTML(page.group)}</p>
<h1 data-pagefind-meta="title">${escapeHTML(page.title)}</h1>
<p class="lede">${escapeHTML(page.description)}</p>${tools}</header>
<div class="prose">${body}</div>${articleEnd(page)}</article>`;
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>${escapeHTML(page.title)} · r3</title>
<meta name="description" content="${escapeHTML(page.description)}">
<link rel="canonical" href="${escapeHTML(origin + (page.path === "/" ? "/" : page.path))}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="r3">
<meta property="og:title" content="${escapeHTML(page.title)}">
<meta property="og:description" content="${escapeHTML(page.description)}">
<meta property="og:url" content="${escapeHTML(origin + page.path)}">
<meta property="og:image" content="${escapeHTML(origin)}/assets/social.png">
<meta name="twitter:card" content="summary_large_image">
<link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/site.css">
<script>${themeScript}</script>
<script type="module" src="/assets/site.js">
</script>
</head>
<body data-base="${escapeHTML(base)}">
<a class="skip-link" href="#main">Skip to content</a>
<header class="site-header">
<a class="brand" href="/" aria-label="r3 home">
<img src="/assets/favicon.svg" width="32" height="32" alt="">
<span>r3</span>
<span class="brand-meaning">Render. Review. Refine.</span>
</a>
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
<button class="theme-toggle js-control" type="button" aria-label="Switch color theme" title="Switch color theme">◐</button>
<a class="button small header-start" href="/docs/get-started/">Get started <span aria-hidden="true">↗</span>
</a>
<details class="mobile-menu">
<summary aria-label="Open navigation">Menu</summary>
<nav aria-label="Mobile navigation">${links}<a href="/docs/get-started/">Get started</a>
</nav>
</details>
</div>
</header>${
    isDoc
      ? `<div class="docs-shell">
<aside class="docs-sidebar">
<nav aria-label="Documentation">${nav(page.path)}</nav>
<a class="agent-link" href="/llms.txt">Reading with an agent? <span>llms.txt ↗</span>
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
      : `<main id="main" class="${article ? "story-layout" : ""}">${article ? `${articleBody}<aside class="toc-column">${toc}</aside>` : body}</main>`
  }<footer class="site-footer">
<div>
<a class="brand" href="/">
<span>r3</span>
</a>
<p>A clearer conversation with your agent.</p>
</div>
<nav aria-label="Footer">
<a href="/docs/get-started/">Get started</a>
<a href="/docs/agents/">For agents</a>
<a href="/llms.txt">llms.txt</a>
<a href="https://github.com/hyperlogue/r3">GitHub ↗</a>
</nav>
<p class="footer-note">Local first. Open source. No site analytics.</p>
</footer>
<div class="toast" role="status" aria-live="polite">
</div>
</body>
</html>`;
}

function articleEnd(page: Page) {
  if (page.path.startsWith("/use-cases/"))
    return `<nav class="article-next" aria-label="Next steps">
<a href="/use-cases/">← All five walkthroughs</a>
<a href="/docs/get-started/">Try it with your agent →</a>
</nav>`;
  const next = docs[docs.findIndex((p) => p.path === page.path) + 1];
  return next
    ? `<nav class="article-next" aria-label="Next page">
<span>Keep reading</span>
<a href="${next.path}">${escapeHTML(next.title)} →</a>
</nav>`
    : "";
}
