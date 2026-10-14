import { startPromptDemo } from "./prompt-demo.ts";
import { promptExamples } from "./prompt-examples.ts";

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

// Captures and the demo link follow the same prompt selection in both the
// public site and opaque artifact previews. The interactive app opens separately.
function selectWorkspace(index: number) {
  const example = promptExamples[index]!;
  for (const frame of document.querySelectorAll<HTMLElement>("[data-workspace-scene]"))
    frame.hidden = frame.dataset.workspaceScene !== example.scene;
  const label = document.querySelector("[data-workspace-label]");
  if (label) label.textContent = example.label;
  const link = document.querySelector<HTMLAnchorElement>(".workspace-demo");
  if (link)
    link.href = siteURL(
      `example/index.html?scene=${example.scene}&theme=${document.documentElement.dataset.theme || "light"}`,
    );
}

function notify(message: string) {
  const toast = document.querySelector<HTMLElement>(".toast");
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), 3500);
}

async function copyText(text: string) {
  if (!artifact && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Some browsers only permit copying from a selected field.
    }
  }
  // This user-initiated fallback also works in the opaque artifact preview,
  // where the native Clipboard API is unavailable.
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.style.cssText = "position:fixed;left:-9999px;top:0";
  const focused = document.activeElement;
  document.body.append(field);
  try {
    field.select();
    if (!document.execCommand("copy")) throw new Error("Copy unavailable");
  } finally {
    field.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  }
}

document.querySelector(".theme-toggle")?.addEventListener("click", () => {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  retainArtifactTheme();
  const demoLink = document.querySelector<HTMLAnchorElement>(".workspace-demo");
  if (demoLink) {
    const url = new URL(demoLink.href);
    url.searchParams.set("theme", theme);
    demoLink.href = url.href;
  }
  try {
    localStorage.setItem("r3-site-theme", theme);
  } catch {
    /* Preferences are optional. */
  }
  notify(`${theme === "dark" ? "Dark" : "Light"} theme`);
});

for (const pre of document.querySelectorAll("pre")) {
  const install = pre.classList.contains("install-command");
  let reset: ReturnType<typeof setTimeout> | undefined;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "copy-code";
  if (install)
    button.innerHTML = `<svg class="copy-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg><svg class="copy-check" width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>`;
  else button.textContent = "Copy";
  button.setAttribute("aria-label", install ? "Copy install command" : "Copy code");
  button.title = install ? "Copy install command" : "Copy code";
  button.addEventListener("click", async () => {
    try {
      await copyText(pre.querySelector("code")?.textContent || "");
      clearTimeout(reset);
      button.dataset.copied = "true";
      button.setAttribute("aria-label", "Copied");
      button.title = "Copied";
      if (!install) button.textContent = "Copied!";
      reset = setTimeout(() => {
        delete button.dataset.copied;
        button.setAttribute("aria-label", install ? "Copy install command" : "Copy code");
        button.title = install ? "Copy install command" : "Copy code";
        if (!install) button.textContent = "Copy";
      }, 2500);
      notify(install ? "Install command copied" : "Code copied");
    } catch {
      const code = pre.querySelector("code");
      if (code) {
        const range = document.createRange();
        range.selectNodeContents(code);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
      notify("Copy is unavailable. The code is selected so you can copy it manually.");
    }
  });
  pre.append(button);
}

for (const demo of document.querySelectorAll<HTMLElement>("[data-prompt-demo]"))
  startPromptDemo(demo, selectWorkspace);

document
  .querySelector<HTMLButtonElement>("[data-markdown]")
  ?.addEventListener("click", async (event) => {
    const url = (event.currentTarget as HTMLButtonElement).dataset.markdown!;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error("Markdown unavailable");
      await copyText(await response.text());
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
