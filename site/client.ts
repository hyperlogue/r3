const root = new URL("../", import.meta.url);
const artifact = document.body.dataset.artifact === "true";
function siteURL(path: string) {
  const url = new URL(path, root);
  if (artifact) {
    if (url.pathname.endsWith("/")) url.pathname += "index.html";
    if (url.pathname.endsWith(".html"))
      url.searchParams.set("theme", document.documentElement.dataset.theme || "light");
  }
  return url.href;
}
document.documentElement.classList.add("has-js");

function retainArtifactTheme() {
  if (!artifact) return;
  for (const link of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const url = new URL(link.href);
    if (
      !link.getAttribute("href")?.startsWith("#") &&
      url.origin === root.origin &&
      url.pathname.startsWith(root.pathname) &&
      url.pathname.endsWith(".html")
    )
      link.href = siteURL(link.href);
  }
}
retainArtifactTheme();

function notify(message: string) {
  const toast = document.querySelector<HTMLElement>(".toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), 3500);
}

document.querySelector(".theme-toggle")?.addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  retainArtifactTheme();
  try {
    localStorage.setItem("r3-site-theme", theme);
  } catch {
    /* Preferences are optional. */
  }
  notify(`${theme === "dark" ? "Dark" : "Light"} theme`);
});

for (const pre of document.querySelectorAll("pre")) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy-code";
  button.textContent = "Copy";
  button.setAttribute("aria-label", "Copy code");
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(pre.querySelector("code")?.textContent || "");
      notify("Code copied");
    } catch {
      notify("Could not copy. Select the code and copy it manually.");
    }
  });
  pre.append(button);
}

document
  .querySelector<HTMLButtonElement>("[data-markdown]")
  ?.addEventListener("click", async (event) => {
    const url = (event.currentTarget as HTMLButtonElement).dataset.markdown!;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Markdown unavailable");
      await navigator.clipboard.writeText(await response.text());
      notify("Page copied as Markdown");
    } catch {
      notify("Could not copy. Use View Markdown to open the text.");
    }
  });

document.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  if (target.closest("input, textarea, select, [contenteditable=true]") || event.altKey) return;
  if (
    (event.key === "/" && !event.metaKey && !event.ctrlKey) ||
    (event.key === "k" && (event.metaKey || event.ctrlKey))
  ) {
    event.preventDefault();
    const input = document.querySelector<HTMLInputElement>("#search-input");
    if (input) input.focus();
    else location.href = siteURL("search/");
  }
  if (event.key === "Escape")
    document.querySelectorAll<HTMLDetailsElement>(".mobile-menu[open]").forEach((menu) => {
      menu.open = false;
      menu.querySelector("summary")?.focus();
    });
});

type SearchResult = { url: string; meta: { title?: string }; excerpt: string };
type SearchIndex = {
  options: (config: { baseUrl: string; noWorker: boolean }) => Promise<void>;
  search: (query: string) => Promise<{ results: { data: () => Promise<SearchResult> }[] }>;
};
const form = document.querySelector<HTMLFormElement>("#search-form");
if (form) {
  const input = document.querySelector<HTMLInputElement>("#search-input")!;
  const status = document.querySelector<HTMLElement>("#search-status")!;
  const results = document.querySelector<HTMLOListElement>("#search-results")!;
  let index: Promise<SearchIndex> | undefined;
  let sequence = 0;
  async function search(query: string) {
    const current = ++sequence;
    results.replaceChildren();
    if (!query.trim()) {
      status.textContent = "Enter a word or phrase to search the docs and use cases.";
      return;
    }
    status.textContent = "Searching…";
    try {
      index ||= import(siteURL("pagefind/pagefind.js")) as Promise<SearchIndex>;
      const api = await index;
      await api.options({ baseUrl: root.href, noWorker: artifact });
      const response = await api.search(query);
      const matches = await Promise.all(
        response.results.slice(0, 20).map((result) => result.data()),
      );
      if (current !== sequence) return;
      status.textContent = response.results.length
        ? `${response.results.length} result${response.results.length === 1 ? "" : "s"}${response.results.length > 20 ? "; showing the first 20" : ""}.`
        : `No results for “${query}”. Try a shorter phrase, or browse the documentation.`;
      for (const match of matches) {
        const item = document.createElement("li");
        const link = document.createElement("a");
        link.href = artifact ? siteURL(match.url) : match.url;
        const title = document.createElement("h2");
        title.textContent = match.meta.title || "Documentation";
        const excerpt = document.createElement("p");
        const parsed = new DOMParser().parseFromString(match.excerpt, "text/html");
        excerpt.textContent = parsed.body.textContent;
        link.append(title, excerpt);
        item.append(link);
        results.append(item);
      }
    } catch {
      if (current === sequence)
        status.textContent =
          "Search could not load. Try again, or browse the documentation directory.";
    }
  }
  const query = new URLSearchParams(location.search).get("q") || "";
  input.value = query;
  if (query) void search(query);
  const submitSearch = () => {
    const url = new URL(siteURL("search/"));
    url.searchParams.set("q", input.value);
    try {
      history.replaceState(null, "", url);
    } catch {
      // Opaque artifact documents can search without changing browser history.
    }
    void search(input.value);
  };
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitSearch();
  });
  if (artifact) {
    // Sandboxed documents disallow native form submission before dispatching
    // submit. Keep button and Enter search local to this document instead.
    form.querySelector('[type="submit"]')?.addEventListener("click", (event) => {
      event.preventDefault();
      submitSearch();
    });
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      submitSearch();
    });
  }
}
