// Server-side syntax highlighting. Dual-theme via CSS variables; cached by content sha.

import { bundledLanguages, bundledThemesInfo, codeToTokens, type ThemedToken } from "shiki";
import type { ThemeOption, ThemeStyle } from "../shared/types.ts";
import { md, REMOTE_URL_RE } from "./mdproject.ts";
import { renderMermaidSvg } from "./mermaid.ts";

// Curated syntax-theme *families*: each is a light/dark pair mapped onto the
// `--shiki-light` / `--shiki-dark` CSS variables, so the client's dark-mode
// toggle picks the readable variant automatically — only the palette changes.
const THEME_FAMILIES: Record<string, { light: string; dark: string }> = {
  github: { light: "github-light", dark: "github-dark" },
  vitesse: { light: "vitesse-light", dark: "vitesse-dark" },
  one: { light: "one-light", dark: "one-dark-pro" },
  material: { light: "material-theme-lighter", dark: "material-theme-ocean" },
  catppuccin: { light: "catppuccin-latte", dark: "catppuccin-mocha" },
};
const FAMILY_LABELS: Record<string, string> = {
  github: "GitHub",
  vitesse: "Vitesse",
  one: "One",
  material: "Material",
  catppuccin: "Catppuccin",
};
const DEFAULT_SYNTAX_THEME = "github";

// Every theme Shiki bundles (shiki.style/themes). Selectable as a single theme
// (used for both light & dark slots, so it renders the same in either mode).
const BUNDLED_IDS = new Set(bundledThemesInfo.map((t) => t.id));

// Resolve a (possibly unknown/undefined) theme id to a canonical name + the
// light/dark theme pair to render. A curated family resolves to its pair; any
// bundled theme id resolves to itself for both slots; anything else → default.
export function resolveTheme(name?: string): { name: string; light: string; dark: string } {
  if (name && THEME_FAMILIES[name]) return { name, ...THEME_FAMILIES[name] };
  if (name && BUNDLED_IDS.has(name)) return { name, light: name, dark: name };
  return { name: DEFAULT_SYNTAX_THEME, ...THEME_FAMILIES[DEFAULT_SYNTAX_THEME] };
}

// The theme picker's option list: curated auto light/dark families first, then
// every bundled Shiki theme. Served from /api/themes so the client gets the
// full set without bundling Shiki's theme data into the browser.
export function listThemes(): ThemeOption[] {
  const families: ThemeOption[] = Object.keys(THEME_FAMILIES).map((id) => ({
    id,
    label: FAMILY_LABELS[id] ?? id,
    group: "Auto (light + dark)",
  }));
  const all: ThemeOption[] = bundledThemesInfo.map((t) => ({
    id: t.id,
    label: `${t.displayName} (${t.type})`,
    group: "All themes",
  }));
  return [...families, ...all];
}

// Pull one CSS variable's value out of a Shiki root-style string like
// "--shiki-light-bg:#2e3440ff;--shiki-dark-bg:#2e3440ff". Keyed on the exact
// var name + ":" so "--shiki-light" doesn't also match "--shiki-light-bg".
function pickVar(style: string | undefined, name: string): string {
  if (!style) return "";
  const m = style.match(new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`));
  return m ? m[1].trim() : "";
}

// The resolved theme's own editor background + default foreground:
// Shiki hands these back from any highlight pass (rootStyle's --shiki-*-bg /
// --shiki-*), but the per-line render throws them away. We surface them so the
// client can paint code surfaces on the theme's real background. Cached per
// resolved theme (it's content-independent).
const themeStyleCache = new Map<string, ThemeStyle>();
export async function themeStyle(theme?: string): Promise<ThemeStyle> {
  const { name, light, dark } = resolveTheme(theme);
  const hit = themeStyleCache.get(name);
  if (hit) return hit;
  let out: ThemeStyle = { lightBg: "", darkBg: "", lightFg: "", darkFg: "" };
  try {
    const r = await tokenize("x", "typescript", light, dark);
    out = {
      lightBg: pickVar(r.bg, "--shiki-light-bg"),
      darkBg: pickVar(r.bg, "--shiki-dark-bg"),
      lightFg: pickVar(r.fg, "--shiki-light"),
      darkFg: pickVar(r.fg, "--shiki-dark"),
    };
  } catch {
    // Unknown theme / tokenizer failure → blanks; client keeps its neutral surface.
  }
  themeStyleCache.set(name, out);
  return out;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Map a file extension to a Shiki language id. Unknown → null (rendered plain).
const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rs: "rust",
  go: "go",
  rb: "ruby",
  java: "java",
  c: "c",
  h: "c",
  cpp: "cpp",
  hpp: "cpp",
  cc: "cpp",
  cs: "csharp",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  scala: "scala",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  fish: "fish",
  lua: "lua",
  sql: "sql",
  html: "html",
  css: "css",
  scss: "scss",
  less: "less",
  json: "json",
  jsonc: "jsonc",
  json5: "json5",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  md: "markdown",
  mdx: "mdx",
  vue: "vue",
  svelte: "svelte",
  graphql: "graphql",
  gql: "graphql",
  dockerfile: "docker",
  nix: "nix",
  proto: "proto",
  wgsl: "wgsl",
  glsl: "glsl",
  diff: "diff",
  ini: "ini",
};

export function langForPath(path: string): string | null {
  const base = path.split("/").pop() ?? "";
  if (base.toLowerCase() === "dockerfile") return "docker";
  const ext = base.includes(".") ? (base.split(".").pop()?.toLowerCase() ?? "") : "";
  return EXT_LANG[ext] ?? null;
}

// The grammar a Markdown fence names: the first word of its info string
// (```ts, ```js {1,3}, ```bash title=run.sh). Shiki's bundled map is keyed by
// language id AND alias, so `ts`, `sh`, `c++` resolve without a table of our
// own; an extension spelling it doesn't know (`gql`) falls back to the path
// map. Unknown — including the deliberate `text`/`plaintext` — → null, which
// renders the fence escaped and unstyled exactly as it did before.
export function langForFence(info: string): string | null {
  const word = info.trim().split(/[\s,{]/)[0];
  const key = word ? word.toLowerCase() : "";
  if (!key) return null;
  if (key in bundledLanguages) return key;
  return EXT_LANG[key] ?? null;
}

function styleOf(t: ThemedToken): string {
  const s = t.htmlStyle;
  if (!s) return t.color ? `color:${t.color}` : "";
  if (typeof s === "string") return s;
  return Object.entries(s)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
}

function tokensToLineHtml(line: ThemedToken[]): string {
  if (line.length === 0) return "";
  let out = "";
  for (const tok of line) {
    const style = styleOf(tok);
    out += `<span${style ? ` style="${style}"` : ""}>${escapeHtml(tok.content)}</span>`;
  }
  return out;
}

// Tokenizing is ~8-40 ms/KB. Cap on main before posting to the worker: nothing
// above this is hand-written (this repo's largest source file is ~100 KB), and
// a 2 MB checked-in bundle measured 83 s. Past it we serve the same escaped
// plain lines the unknown-grammar path already produces, so no caller or
// client changes.
export const MAX_HIGHLIGHT_BYTES = 256 * 1024;

// Bounded LRU so a long-running server doesn't accumulate the highlighted copy
// of every blob ever rendered. Map iteration order is insertion order, so the
// first key is the least-recently-used.
// Budgeted in BYTES, not entries: an entry is a whole file's per-line HTML, so
// a count bound says nothing about what is retained. 512 entries of a 19 KB
// source measured 1.1 GB RSS, and one 2 MB file makes a single entry ~39 MB.
const LINE_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const lineCache = new Map<string, string[]>();
const lineCacheCost = new Map<string, number>();
let lineCacheBytes = 0;
function costOf(v: string[]): number {
  let n = 0;
  for (const l of v) n += l.length + 64; // + per-string object overhead
  return n;
}
function cacheGet(key: string): string[] | undefined {
  const v = lineCache.get(key);
  if (v) {
    lineCache.delete(key);
    lineCache.set(key, v);
  }
  return v;
}
function cacheSet(key: string, v: string[]): void {
  lineCacheBytes -= lineCacheCost.get(key) ?? 0;
  const cost = costOf(v);
  lineCache.set(key, v);
  lineCacheCost.set(key, cost);
  lineCacheBytes += cost;
  // A loop, not an `if`: one oversized insert can overshoot the budget by more
  // than a single eviction reclaims.
  while (lineCacheBytes > LINE_CACHE_MAX_BYTES && lineCache.size > 1) {
    const oldest = lineCache.keys().next().value;
    if (oldest === undefined) break;
    lineCacheBytes -= lineCacheCost.get(oldest) ?? 0;
    lineCache.delete(oldest);
    lineCacheCost.delete(oldest);
  }
}

// codeToTokens on one reused worker so highlighting does not block SSE / r3
// watch. Idle-unref so tests and gen-demo-fixtures can exit. Worker missing
// or failing to load → in-process; timeout / tokenizer error → throw (escaped
// plain lines, same as today's catch).
const TOKENIZE_TIMEOUT_MS = 30_000;

type TokenizeResult = { tokens: ThemedToken[][]; bg?: string; fg?: string };
type HighlightWorker = Worker & { ref(): void; unref(): void };
type Pending = {
  resolve: (r: TokenizeResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

let worker: HighlightWorker | null = null;
let workerDisabled = false;
let workerEverOk = false;
let nextTokenizeId = 0;
const pending = new Map<number, Pending>();

function tokenizeLocal(
  code: string,
  lang: string,
  light: string,
  dark: string,
): Promise<TokenizeResult> {
  return codeToTokens(code, {
    lang: lang as never,
    themes: { light, dark },
    defaultColor: false,
  }).then((r) => {
    const { tokens, bg, fg } = r as TokenizeResult;
    return { tokens, bg, fg };
  });
}

function dropWorker(err: Error): void {
  const w = worker;
  worker = null;
  const jobs = [...pending.values()];
  pending.clear();
  for (const p of jobs) {
    clearTimeout(p.timer);
    p.reject(err);
  }
  if (!w) return;
  try {
    w.terminate();
  } catch {
    // already gone
  }
}

function onWorkerMessage(ev: MessageEvent): void {
  const data = ev.data as {
    id?: number;
    tokens?: ThemedToken[][];
    bg?: string;
    fg?: string;
    error?: string;
  };
  if (data.id == null) return;
  const p = pending.get(data.id);
  if (!p) return;
  pending.delete(data.id);
  clearTimeout(p.timer);
  if (pending.size === 0) worker?.unref();
  if (data.error != null || data.tokens == null) {
    p.reject(new Error(data.error ?? "highlight worker returned no tokens"));
    return;
  }
  workerEverOk = true;
  p.resolve({ tokens: data.tokens, bg: data.bg, fg: data.fg });
}

function onWorkerGone(): void {
  if (!workerEverOk) workerDisabled = true;
  dropWorker(new Error("highlight worker stopped"));
}

function highlightWorkerSpecifier(): string | URL {
  // From-source: resolve next to this file. bun --compile does not rewrite
  // `new URL("./x", import.meta.url)` into an embedded worker (even listed as
  // an extra entrypoint); the compiled lookup is the extra entry's path.
  const p = import.meta.path;
  if (p.includes("$bunfs") || p.includes("~BUN")) return "./server/highlight-worker.ts";
  return new URL("./highlight-worker.ts", import.meta.url);
}

function ensureWorker(): HighlightWorker | null {
  if (workerDisabled) return null;
  if (worker) return worker;
  if (typeof Worker === "undefined") {
    workerDisabled = true;
    return null;
  }
  try {
    const w = new Worker(highlightWorkerSpecifier()) as HighlightWorker;
    w.addEventListener("message", onWorkerMessage);
    w.addEventListener("error", onWorkerGone);
    w.addEventListener("close", onWorkerGone);
    w.unref();
    worker = w;
    return w;
  } catch {
    workerDisabled = true;
    return null;
  }
}

function requestTokens(
  w: HighlightWorker,
  code: string,
  lang: string,
  light: string,
  dark: string,
): Promise<TokenizeResult> {
  return new Promise((resolve, reject) => {
    const id = ++nextTokenizeId;
    const timer = setTimeout(() => {
      if (!pending.has(id)) return;
      if (!workerEverOk) workerDisabled = true;
      dropWorker(new Error("highlight worker timeout"));
    }, TOKENIZE_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    w.ref();
    w.postMessage({ id, code, lang, light, dark });
  });
}

async function tokenize(
  code: string,
  lang: string,
  light: string,
  dark: string,
): Promise<TokenizeResult> {
  const w = ensureWorker();
  if (!w) return tokenizeLocal(code, lang, light, dark);
  try {
    return await requestTokens(w, code, lang, light, dark);
  } catch (e) {
    // Timeout → escaped plain (caller catch), even if we also disable a worker
    // that never came up. Load/spawn failure → in-process so tests still highlight.
    if (e instanceof Error && e.message === "highlight worker timeout") throw e;
    if (workerDisabled) return tokenizeLocal(code, lang, light, dark);
    throw e;
  }
}

// Highlight `code` into an array of per-line inner HTML (one entry per source
// line). The spans carry `--shiki-light` / `--shiki-dark` CSS variables; the
// client's CSS picks the active one. Cached by `cacheKey` (a content sha).
export async function highlightToLines(
  code: string,
  lang: string | null,
  cacheKey?: string,
  theme?: string,
): Promise<string[]> {
  const { name: themeName, light, dark } = resolveTheme(theme);
  const key = cacheKey ? `${cacheKey}:${lang ?? "text"}:${themeName}` : null;
  if (key) {
    const hit = cacheGet(key);
    if (hit) return hit;
  }

  let lines: string[];
  if (!lang || code.length > MAX_HIGHLIGHT_BYTES) {
    lines = code.split("\n").map((l) => escapeHtml(l));
  } else {
    try {
      const { tokens } = await tokenize(code, lang, light, dark);
      lines = tokens.map(tokensToLineHtml);
    } catch {
      // Unknown grammar or tokenizer failure → plain, never crash a render.
      lines = code.split("\n").map((l) => escapeHtml(l));
    }
  }
  // codeToTokens drops a trailing empty line; keep arrays aligned to source.
  const srcLineCount = code.length === 0 ? 1 : code.split("\n").length;
  while (lines.length < srcLineCount) lines.push("");
  if (key) cacheSet(key, lines);
  return lines;
}

// ---- Markdown render. The `md` instance lives in mdproject.ts (anchor search
// projects the same parse — the two must agree); this module adds render-only rules.

// Remote images fetch with no click, so they'd beacon on view; render them as
// links instead (REMOTE_URL_RE, mdproject.ts).
const defaultImage =
  md.renderer.rules.image ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const src = tokens[idx].attrGet("src") ?? "";
  if (!REMOTE_URL_RE.test(src)) return defaultImage(tokens, idx, options, env, self);
  const alt = self.renderInlineAsText(tokens[idx].children ?? [], options, env);
  return (
    `<a class="r3-remote-img" href="${escapeHtml(src)}" target="_blank" rel="noopener noreferrer"` +
    ` title="Remote image — not loaded automatically">${escapeHtml(alt || src)}</a>`
  );
};
// ---- Links. Relative targets resolve against the containing file's directory
// (not the SPA page URL) and the client jumps to that file's card. A scheme /
// `//host` keeps new-tab. A link with no target would navigate the SPA away. ----

// Resolve a link target against the directory of the file that contains it.
// Lexical only, no fs: the result is matched against the review's file list on
// the client and never read, so a path that climbs out of the repo simply fails
// to match (and renders dead) rather than needing a guard. A leading `/` is
// repo-root-relative, as it is on GitHub.
//
// It is deliberately NOT safePathIn: it has to be able to *return* `../…` so the
// client can recognize an out-of-review target. That makes it unsafe as a read
// path — anything that ever turns one of these into a file read must put it
// through `repo.safePath()` first.
function resolveDocPath(from: string, href: string): string {
  const out = href.startsWith("/") ? [] : from.split("/").slice(0, -1);
  for (const seg of href.replace(/^\//, "").split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push(seg);
  }
  return out.join("/");
}

// GitHub-style heading slug: lowercased, punctuation dropped, spaces to dashes.
// Unicode-aware, so a CJK or accented heading keeps its letters instead of
// slugging to nothing.
function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const href = token.attrGet("href") ?? "";
  if (REMOTE_URL_RE.test(href)) {
    token.attrSet("target", "_blank");
    token.attrSet("rel", "noopener noreferrer");
    return defaultLinkOpen(tokens, idx, options, env, self);
  }
  // markdown-it percent-encodes the href it stores; the path we hand back is
  // compared against review file paths, so undo that first (a malformed escape
  // just stays as written).
  let raw = href;
  try {
    raw = decodeURIComponent(href);
  } catch {}
  const hashAt = raw.indexOf("#");
  const hash = hashAt === -1 ? "" : raw.slice(hashAt + 1);
  // Drop a query string: it means nothing to a file in a review.
  const path = (hashAt === -1 ? raw : raw.slice(0, hashAt)).split("?")[0];
  const from = (env as { path?: string } | undefined)?.path ?? "";
  // A bare `#fragment` points inside the file being rendered.
  const file = path === "" ? from : resolveDocPath(from, path);
  token.attrJoin("class", "r3-doclink");
  token.attrSet("data-r3-doc-file", file);
  if (hash) token.attrSet("data-r3-doc-hash", slugify(hash));
  // `href="#"` keeps the link focusable (so Enter fires the same click) while
  // making the fallback navigation harmless — the client preventDefaults it.
  token.attrSet("href", "#");
  if (token.attrGet("title") == null) token.attrSet("title", hash ? `${file}#${hash}` : file);
  return defaultLinkOpen(tokens, idx, options, env, self);
};

// ---- Fenced code blocks. A named grammar gets the same Shiki pass as the code
// view; unknown/absent stays escaped. ` ```mermaid ` / ` ```mmd ` is the exception
// (safe SVG). markdown-it is sync and Shiki is async, so highlight after parse
// and render those same tokens — no second parse, no module-level scratch state.

interface FenceHighlight {
  html: string;
  mermaid?: boolean;
}

const defaultFence =
  md.renderer.rules.fence ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const hl = token.meta as FenceHighlight | undefined;
  if (hl?.html == null) return defaultFence(tokens, idx, options, env, self);
  if (hl.mermaid) {
    // The data-line-* the core rule tagged ride the wrapper so a note on the
    // fence still has an innermost range, same as a <pre><code> fence.
    token.attrJoin("class", "r3-mermaid");
    return `<div${self.renderAttrs(token)}>${hl.html}</div>\n`;
  }
  // The wrapper the default rule would have emitted — the fence's own info word
  // as `language-*`, plus the data-line-* the core rule tagged — with the
  // highlighted body in place of the escaped text. `shiki-code` is what maps
  // each token span's --shiki-light/--shiki-dark onto `color` (web/src/main.css),
  // the same class the code rows carry.
  const info = md.utils.unescapeAll(token.info).trim().split(/\s+/)[0];
  token.attrJoin("class", "shiki-code");
  if (info) token.attrJoin("class", options.langPrefix + info);
  return `<pre><code${self.renderAttrs(token)}>${hl.html}</code></pre>\n`;
};

// Highlight every fence in a parsed token stream (in parallel — each is an
// independent Shiki pass, cached by content sha like any other blob). The token
// stream is flat, so a fence nested in a list item or blockquote is covered too.
async function highlightFences(tokens: ReturnType<typeof md.parse>, theme?: string): Promise<void> {
  await Promise.all(
    tokens.map(async (token) => {
      if (token.type !== "fence") return;
      const info = md.utils.unescapeAll(token.info);
      const svg = renderMermaidSvg(info, token.content);
      if (svg) {
        token.meta = { ...(token.meta ?? {}), html: svg, mermaid: true } satisfies FenceHighlight;
        return;
      }
      const lang = langForFence(info);
      if (!lang) return;
      const sha = new Bun.CryptoHasher("sha1").update(token.content).digest("hex");
      const lines = await highlightToLines(token.content, lang, sha, theme);
      token.meta = { ...(token.meta ?? {}), html: lines.join("\n") } satisfies FenceHighlight;
    }),
  );
}

// Inject data-line attributes from token.map onto block-level open tokens.
// NESTED blocks are tagged too, not just top-level ones: markdown has no
// per-line rows, so whatever we tag is the finest range a browser selection can
// report, and a top-level-only pass made a note on one bullet come back as its
// whole <ul> (a table cell as the whole table). markdown-it maps list_item_open
// and tr_open individually, so tagging them narrows the anchor to the item/row.
// The client resolves a click/selection to the INNERMOST tagged ancestor and
// marks only innermost blocks (web/src/highlights.ts), so the ancestors that
// still carry a range never widen it back.
md.core.ruler.push("line_numbers", (state) => {
  for (const token of state.tokens) {
    // Hidden tokens (a tight list item's implicit paragraph) render no element,
    // and their map duplicates the item's anyway.
    if (!token.map || token.hidden) continue;
    // fences and indented code blocks are self-contained (no _open/_close) —
    // tag them too, or a selection inside one finds no anchor ancestor.
    if (token.type.endsWith("_open") || token.type === "fence" || token.type === "code_block") {
      token.attrSet("data-line-start", String(token.map[0] + 1));
      token.attrSet("data-line-end", String(token.map[1]));
    }
  }
  return true;
});

// Tag each heading with its slug so a doc link's `#fragment` has something to
// land on. NOT an `id`: every file in a review renders into one page, so two
// docs with a "## Cost" section would collide on a global id and native
// fragment nav would scroll to whichever came first. The client scopes the
// lookup to the target file's card instead. Duplicates within one file get the
// `-1`, `-2` suffix GitHub uses.
md.core.ruler.push("heading_slugs", (state) => {
  const seen = new Map<string, number>();
  state.tokens.forEach((token, i) => {
    if (token.type !== "heading_open") return;
    const inline = state.tokens[i + 1];
    const slug = slugify(inline?.type === "inline" ? inline.content : "");
    if (!slug) return;
    const n = seen.get(slug) ?? 0;
    seen.set(slug, n + 1);
    token.attrSet("data-r3-heading", n === 0 ? slug : `${slug}-${n}`);
  });
  return true;
});

// `path` is the reviewed file's repo-relative path — the base every relative
// link in it resolves against (see the link rule above). `theme` is the
// reader's syntax theme, applied to the fences (above).
//
// Deliberately parse → highlight → render rather than `md.render`: the fence
// highlights are async and ride the tokens, so the renderer has to see the very
// tokens that were highlighted.
export async function renderMarkdown(
  source: string,
  path: string,
  theme?: string,
): Promise<string> {
  const env = { path };
  const tokens = md.parse(source, env);
  await highlightFences(tokens, theme);
  return md.renderer.render(tokens, md.options, env);
}
