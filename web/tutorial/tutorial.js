const $ = (selector) => document.querySelector(selector);
const escapeHTML = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[character],
  );
const icons = {
  comment:
    '<path d="M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9H13a8.5 8.5 0 0 1 8 8v.5Z"/><path d="M8 11h8m-4-4v8"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16"/>',
  folder:
    '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z"/><path d="M3 9h18"/>',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
const lessons = [
  {
    short: "Publish an artifact",
    title: "Give your work a place to live.",
    description:
      "An artifact is a versioned piece of work with a conversation around it. Start by publishing a small HTML page.",
    task: "Click Publish sample to turn this directory into version 1.",
    note: "In the real app, an agent or the CLI publishes the files. Editing your local directory alone does not change a published version.",
  },
  {
    short: "Anchor your feedback",
    title: "Point to exactly what you mean.",
    description:
      "Turn on comment mode, then select the reading-time estimate. Your feedback will remember this element in version 1.",
    task: "Enable comment mode in the practice navbar, then click “5 min read”.",
    note: "Rendered targets belong to the page: element, text, route, and viewport. They are not guessed source-line numbers.",
  },
  {
    short: "Bring in an agent",
    title: "Make it a conversation.",
    description:
      "Send your feedback to the practice agent. Watch it claim the thread, make a change, publish, and reply.",
    task: "Click Send to agent in the feedback card. This is a simulation; no message leaves the tutorial.",
    note: "Agents claim stable feedback IDs to coordinate work. A reply releases that agent’s claim, while the thread stays open.",
  },
  {
    short: "Review the new version",
    title: "New work. Your place, preserved.",
    description:
      "Version 2 is published, but you are still viewing version 1. Switch when you are ready to inspect the change.",
    task: "Click Go to the latest version. Use the version selector to compare the reading-time estimate.",
    note: "Publishing never silently moves your selected version. The original feedback target remains in version 1; the agent’s reply points to version 2.",
  },
  {
    short: "Resolve the thread",
    title: "You decide when it is done.",
    description:
      "The reading-time estimate is fixed. Close the loop by resolving the feedback, then find it in the Resolved queue.",
    task: "Click Resolve in the feedback card. Agent replies and publications never do this for you.",
    note: "Resolved conversations stay in the artifact’s history. You can still inspect their original context.",
  },
  {
    short: "Explore all three kinds",
    title: "One review loop. Three kinds of work.",
    description:
      "Switch between three separate sample artifacts. HTML is a rendered experience, Files is a complete directory, and Diff is a captured patch.",
    task: "Open the HTML, Files, and Diff samples. Try folding the Markdown file or switching it to source.",
    note: "An artifact’s kind is fixed. These buttons switch between separate examples; they do not convert the same artifact.",
  },
];
const freshState = () => ({
  step: 0,
  published: false,
  commentMode: false,
  composer: false,
  draft: "",
  feedback: "",
  working: false,
  replied: false,
  selectedVersion: 1,
  inspected: false,
  resolved: false,
  queue: "active",
  panel: "docked",
  lastPanel: "docked",
  kind: "html",
  visited: new Set(["html"]),
  fileOpen: true,
  fileView: "rendered",
});
let state = freshState();
let agentTimer;
let animateCard = false;
const completion = () => [
  state.published,
  !!state.feedback,
  state.replied,
  state.inspected,
  state.resolved,
  state.visited.size === 3,
];
const nextLesson = () => Math.min(state.step + 1, lessons.length - 1);
const activeKind = () => (state.step === 5 ? state.kind : "html");

function render() {
  const lesson = lessons[state.step];
  const done = completion();
  const count = done.filter(Boolean).length;
  $("#progress-label").textContent = `${count} / 6`;
  $("#progress").setAttribute("aria-valuenow", String(count));
  $("#progress-fill").style.width = `${(count / 6) * 100}%`;
  $("#steps").innerHTML = lessons
    .map(
      (item, index) =>
        `<button type="button" class="step ${index === state.step ? "current" : ""} ${done[index] ? "done" : ""}" data-action="step" data-step="${index}" ${index > 0 && !done.slice(0, index).every(Boolean) ? "disabled" : ""} ${index === state.step ? 'aria-current="step"' : ""}><span class="step-number">${done[index] ? "✓" : index + 1}</span><span class="step-label">${item.short}</span></button>`,
    )
    .join("");
  $("#lesson-number").textContent = `Step 0${state.step + 1} / 06`;
  $("#lesson-title").textContent = lesson.title;
  $("#lesson-description").textContent = lesson.description;
  $("#lesson-note").textContent = lesson.note;
  let task = lesson.task;
  if (state.step === 1 && state.composer)
    task =
      "Write your feedback and save it. For example: “This is a longer read. Could we use 10 minutes?”";
  if (state.step === 2 && state.working)
    task = "The practice agent has claimed this thread and is preparing version 2…";
  if (done[state.step])
    task =
      state.step === 5
        ? "✓ You have completed the review loop. Explore the workspace, open the CLI companion, or start again."
        : `✓ ${["Version 1 is published.", "Your feedback is anchored to version 1.", `Version 2 is published. You are viewing version ${state.selectedVersion}.`, "You have inspected version 2.", "Resolved by you. The conversation stays in history."][state.step]}`;
  $("#task").innerHTML =
    `<span>${escapeHTML(task)}</span>${done[state.step] && state.step < 5 ? `<button type="button" class="primary" data-action="next">${lessons[nextLesson()].short} →</button>` : ""}`;
  $("#workspace").innerHTML = workspace();
  animateCard = false;
}

function workspace() {
  const kind = activeKind();
  const html = kind === "html";
  const title = {
    html: "Weekend guide",
    files: "Weekend guide · editorial notes",
    diff: "Weekend guide · reading-time patch",
  }[kind];
  return `${state.step === 5 ? `<div class="kind-tabs" aria-label="Sample artifacts">${["html", "files", "diff"].map((item) => `<button type="button" data-action="kind" data-kind="${item}" aria-pressed="${item === kind}" class="${item === kind ? "selected" : ""}">${{ html: "HTML", files: "Files", diff: "Diff" }[item]} ${state.visited.has(item) ? "✓" : ""}</button>`).join("")}</div>` : ""}
    <header class="workspace-nav"><span class="workspace-mark">r3</span><span class="artifact-title">${title}</span>
      ${html && state.replied && state.selectedVersion === 1 ? '<button type="button" data-action="latest">Go to the latest version</button>' : ""}
      ${state.published ? `<div class="version"><select aria-label="Selected version" id="version" ${html && state.replied ? "" : "disabled"}><option value="1" ${!html || state.selectedVersion === 1 ? "selected" : ""}>v1${!html || !state.replied ? " · Latest" : ""}</option>${html && state.replied ? `<option value="2" ${state.selectedVersion === 2 ? "selected" : ""}>v2 · Latest</option>` : ""}</select></div>` : ""}
      ${html ? `<button type="button" class="icon-button ${state.commentMode ? "selected" : ""}" data-action="comment" aria-label="Comment mode" title="Comment mode" aria-pressed="${state.commentMode}" ${!state.published || state.feedback ? "disabled" : ""}>${icon("comment")}</button><button type="button" class="icon-button" data-action="panel" title="${state.panel === "hidden" ? "Show" : "Hide"} feedback" aria-label="${state.panel === "hidden" ? "Show" : "Hide"} feedback" aria-expanded="${state.panel !== "hidden"}">${icon("panel")}</button>` : ""}
    </header>
    <div class="workspace-body"><div class="content">${!state.published ? publishEmpty() : html ? sampleDocument() : kind === "files" ? filesSample() : diffSample()}</div>${html && state.panel !== "hidden" ? feedbackPanel() : ""}</div>`;
}

function publishEmpty() {
  return `<div class="publish-empty"><span class="folder">${icon("folder")}</span><h3>Your next artifact starts here.</h3><p>A complete directory of files, published as an immutable version.</p><pre class="file-tree">weekend-guide/
├── index.html
├── styles.css
└── assets/</pre><div><button type="button" class="primary" data-action="publish">Publish sample</button></div></div>`;
}

function sampleDocument() {
  return `<article class="sample-doc ${state.commentMode ? "commenting" : ""}"><p class="eyebrow">Field notes / Issue 03</p><h3>A little room<br>for the weekend.</h3><p class="reading-time ${state.feedback ? "anchored" : ""}" ${state.commentMode || state.feedback ? 'role="button" tabindex="0" data-action="anchor"' : ""} aria-label="${state.selectedVersion === 1 ? 5 : 10} min read${state.feedback ? ", one feedback thread" : ""}">${state.selectedVersion === 1 ? 5 : 10} min read${state.feedback ? '<sup aria-hidden="true">①</sup>' : ""}</p><p>There is a particular kind of morning that asks very little of you. A window left open, something warm to drink, and an afternoon with no appointments.</p><p>We gathered a few ideas for making more of that space. Take a longer walk. Make something slowly. Leave a little time unplanned.</p><div class="editorial-grid"><div><h4>Take the scenic route</h4><p>A short walk can become the best part of the day. Let curiosity choose the turns.</p></div><div><h4>Make room to make</h4><p>Pick up the sketchbook, the recipe, or the idea you have been saving for later.</p></div></div></article>`;
}

function feedbackPanel() {
  const active = state.feedback && !state.resolved ? 1 : 0;
  const visibleThread = state.feedback && (state.queue === "resolved") === state.resolved;
  return `<aside class="feedback-panel ${state.panel === "floating" ? "floating" : ""}" aria-label="Practice feedback panel"><div class="panel-heading"><strong>Feedback</strong><button type="button" data-action="float">${state.panel === "floating" ? "Dock" : "Float"}</button><button type="button" data-action="panel">Hide</button></div><div class="filter-bar"><button type="button" data-action="queue" data-queue="active" aria-pressed="${state.queue === "active"}">Active ${active}</button><button type="button" data-action="queue" data-queue="resolved" aria-pressed="${state.queue === "resolved"}">Resolved ${state.resolved ? 1 : 0}</button></div><div class="panel-content">${state.composer && state.queue === "active" ? composer() : visibleThread ? feedbackCard() : `<div class="panel-empty">${state.queue === "resolved" ? "No resolved feedback yet." : state.feedback ? "All caught up. Find this thread in Resolved." : "Point to something in the page to start a conversation."}</div>`}</div></aside>`;
}

function composer() {
  return `<div class="composer"><div class="composer-target">v1 · rendered · index.html<br>“5 min read”</div><label for="feedback-draft">Your feedback</label><textarea id="feedback-draft" placeholder="What should change?">${escapeHTML(state.draft)}</textarea><div class="composer-actions"><button type="button" class="primary" data-action="save" ${!state.draft.trim() ? "disabled" : ""}>Save feedback</button></div></div>`;
}

function feedbackCard() {
  return `<article class="feedback-card ${animateCard ? "arrival" : ""}"><button type="button" class="feedback-target" data-action="locate" title="Return to the original target">v1 · rendered · index.html ↗<br>“5 min read”</button><div class="message"><div class="message-meta"><span class="avatar">Y</span><strong>You</strong><span>· just now</span></div><p>${escapeHTML(state.feedback)}</p></div>${state.working ? '<div class="claim" role="status">◌ Practice agent is handling this feedback…</div>' : ""}${state.replied ? '<div class="message"><div class="message-meta"><span class="avatar">A</span><strong>Practice agent</strong></div><p>Updated the reading estimate to 10 minutes and published version 2. Ready for your review.</p><span class="reply-context">v2 · rendered · index.html</span></div>' : ""}<div class="thread-actions">${!state.replied ? `<button type="button" class="primary" data-action="send" ${state.working ? "disabled" : ""}>${state.working ? "Working…" : "Send to agent"}</button>` : state.resolved ? '<span class="resolved-label">✓ Resolved by you</span>' : `<button type="button" class="resolve" data-action="resolve" ${!state.inspected ? 'disabled title="Inspect version 2 first in this tutorial"' : ""}>✓ Resolve</button>`}</div></article>`;
}

function filesSample() {
  return `<div class="artifact-caption">Files artifact · a complete directory · Markdown opens rendered</div><div class="file-heading"><button type="button" data-action="fold" aria-label="${state.fileOpen ? "Fold" : "Unfold"} README.md" aria-expanded="${state.fileOpen}">${state.fileOpen ? "▾" : "▸"}</button><code>README.md</code><button type="button" data-action="file-view" data-view="source" aria-pressed="${state.fileView === "source"}" class="${state.fileView === "source" ? "selected" : ""}">Source</button><button type="button" data-action="file-view" data-view="rendered" aria-pressed="${state.fileView === "rendered"}" class="${state.fileView === "rendered" ? "selected" : ""}">Rendered</button></div>${state.fileOpen ? (state.fileView === "rendered" ? '<article class="markdown-example"><h3>Weekend guide</h3><p>Editorial notes for the next issue.</p><ul><li>Use a realistic reading estimate.</li><li>Keep the layout calm and readable.</li><li>Publish the complete directory for each revision.</li></ul><p>Markdown opens in rendered view, uses the r3 theme, and takes its full document height.</p></article>' : '<pre class="source-example"><span class="syntax"># Weekend guide</span>\n\nEditorial notes for the next issue.\n\n<span class="syntax">-</span> Use a realistic reading estimate.\n<span class="syntax">-</span> Keep the layout calm and readable.\n<span class="syntax">-</span> Publish the complete directory for each revision.\n\nMarkdown opens in rendered view, uses the r3 theme,\nand takes its full document height.</pre>') : ""}<div class="file-heading"><code>notes.txt</code><span>Source</span></div><pre class="source-example" style="min-height:0">Next issue: small adventures, close to home.</pre>`;
}

function diffSample() {
  return '<div class="artifact-caption">Diff artifact · an independent captured patch · old and new sides</div><div class="file-heading"><code>index.html</code><span>−1 +1</span></div><div class="diff-example"><div class="hunk">@@ −12,3 +12,3 @@</div><div>12  12    &lt;h1&gt;A little room for the weekend.&lt;/h1&gt;</div><div class="deletion">13      − &lt;p&gt;5 min read&lt;/p&gt;</div><div class="addition">    13  + &lt;p&gt;10 min read&lt;/p&gt;</div><div>14  14    &lt;p&gt;There is a particular kind of morning…&lt;/p&gt;</div></div><div class="markdown-example"><h3>Review the change itself.</h3><p>Feedback can target an old or new line. The patch retains the captured context; it is not a reconstructed file tree.</p><p>Each published diff version stands on its own.</p></div>';
}

function selectVersion(version) {
  state.selectedVersion = version;
  if (version === 2) state.inspected = true;
}

function act(action, element) {
  const restoreFocus = document.activeElement === element;
  const identity = ["step", "kind", "queue", "view"].filter((key) => element.dataset[key]);
  const sameControl = `[data-action="${action}"]${identity.map((key) => `[data-${key}="${element.dataset[key]}"]`).join("")}`;
  switch (action) {
    case "publish":
      state.published = true;
      break;
    case "next":
      state.step = nextLesson();
      break;
    case "step":
      state.step = Number(element.dataset.step);
      break;
    case "comment":
      state.commentMode = !state.commentMode;
      break;
    case "anchor":
      if (state.feedback) {
        state.queue = state.resolved ? "resolved" : "active";
      } else {
        state.composer = true;
        state.queue = "active";
      }
      if (state.panel === "hidden") state.panel = state.lastPanel;
      break;
    case "save":
      if (!state.draft.trim()) return;
      state.feedback = state.draft.trim();
      state.composer = false;
      state.commentMode = false;
      animateCard = true;
      break;
    case "send":
      if (state.working || state.replied) return;
      state.working = true;
      agentTimer = setTimeout(() => {
        state.working = false;
        state.replied = true;
        render();
      }, 1500);
      break;
    case "latest":
      selectVersion(2);
      break;
    case "locate":
      selectVersion(1);
      break;
    case "resolve":
      if (!state.replied || !state.inspected) return;
      state.resolved = true;
      state.queue = "resolved";
      break;
    case "queue":
      state.queue = element.dataset.queue;
      break;
    case "panel":
      if (state.panel === "hidden") state.panel = state.lastPanel;
      else {
        state.lastPanel = state.panel;
        state.panel = "hidden";
      }
      break;
    case "float":
      state.panel = state.panel === "floating" ? "docked" : "floating";
      state.lastPanel = state.panel;
      break;
    case "kind":
      state.kind = element.dataset.kind;
      state.visited.add(state.kind);
      break;
    case "fold":
      state.fileOpen = !state.fileOpen;
      break;
    case "file-view":
      state.fileView = element.dataset.view;
      break;
    case "reset":
      clearTimeout(agentTimer);
      state = freshState();
      break;
    case "theme":
      toggleTheme();
      return;
    case "commands":
      $("#commands-dialog").showModal();
      return;
    case "close-commands":
      $("#commands-dialog").close();
      return;
    default:
      return;
  }
  render();
  if (restoreFocus) {
    const focusTarget =
      action === "anchor" && state.composer
        ? $("#feedback-draft")
        : ($(sameControl) ?? $('#task [data-action="next"]'));
    focusTarget?.focus({ preventScroll: true });
  }
  if (action === "anchor" && state.composer)
    $("#feedback-draft")?.scrollIntoView({ block: "nearest" });
}

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) return;
  act(button.dataset.action, button);
});
document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (target.matches('[role="button"][data-action]') && ["Enter", " "].includes(event.key)) {
    event.preventDefault();
    if (!event.repeat) act(target.dataset.action, target);
  }
  if (target.id === "feedback-draft" && event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    if (!event.repeat) act("save", target);
  }
});
document.addEventListener("input", (event) => {
  if (event.target.id !== "feedback-draft") return;
  state.draft = event.target.value;
  $('[data-action="save"]').disabled = !state.draft.trim();
});
document.addEventListener("change", (event) => {
  if (event.target.id !== "version") return;
  selectVersion(Number(event.target.value));
  render();
  $("#version").focus({ preventScroll: true });
});

const utility = globalThis.__r3ArtifactUtility;
let themeTouched = false;
function applyTheme(theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  $("#theme").textContent = `Switch to ${theme === "dark" ? "light" : "dark"}`;
}
function toggleTheme() {
  themeTouched = true;
  const theme = document.documentElement.classList.contains("dark") ? "light" : "dark";
  applyTheme(theme);
  if (utility?.setTheme) void utility.setTheme(theme).catch(() => {});
  else {
    try {
      localStorage.setItem("r3-tutorial-theme", theme);
    } catch {
      /* The page remains usable when browser storage is unavailable. */
    }
  }
}
applyTheme(
  document.documentElement.classList.contains("dark") ||
    matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light",
);
if (utility?.getTheme) {
  void utility
    .getTheme()
    .then((theme) => {
      if (theme && !themeTouched) applyTheme(theme);
    })
    .catch(() => {});
} else {
  try {
    const theme = localStorage.getItem("r3-tutorial-theme");
    if (theme === "dark" || theme === "light") applyTheme(theme);
  } catch {
    /* Opaque previews persist theme through the scoped utility above. */
  }
}
render();
