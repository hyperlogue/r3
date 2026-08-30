// Server-side syntax highlighting. Dual-theme via palette classes + one
// per-theme stylesheet (below); cached by content sha.

import {
  bundledLanguages,
  bundledThemes,
  bundledThemesInfo,
  codeToTokens,
  type ThemedToken,
  type ThemeRegistrationResolved,
} from "shiki";
import { applyColorReplacements, normalizeTheme } from "shiki/core";
import type { ThemeOption, ThemeStyle } from "../shared/types.ts";
import { md, REMOTE_URL_RE } from "./mdproject.ts";
import { renderMermaidSvg } from "./mermaid.ts";

// Curated syntax-theme *families*: each is a light/dark pair, rendered into the
// two class slots below, so the client's dark-mode toggle picks the readable
// variant automatically — only the palette changes.
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

// ---- The token palette ---------------------------------------------------
//
// Every rendered code line reaches the browser as Shiki HTML, and each token
// span used to carry both of its colours inline:
// `<span style="--shiki-light:#24292E;--shiki-dark:#E1E4E8">`. Measured on a
// real 208-file review that is ~5 spans and 425 JSON bytes per SOURCE line —
// 22.7 MB of blob JSON for 1.85 MB of source (12.3x), a single 5.8k-line file
// at 2.5 MB — and on the browser side every mounted span then owns a style
// declaration to parse and a unique computed style to keep.
//
// A token can only ever wear a colour its theme names, so the whole palette is
// knowable before anything is tokenized: index the resolved theme's distinct
// foregrounds once, emit a class per slot (`sl<i>` light, `sd<j>` dark), and
// ship the colours ONCE as the stylesheet in `ThemeStyle.css`. Same pixels,
// ~20 bytes a span instead of ~55, one shared rule per colour instead of one
// declaration per span.
//
// Class names are a 2-letter prefix + digits, which is no Tailwind utility's
// shape, and they appear nowhere in `web/src` — Tailwind generates only what its
// scanner finds there, so it can never mint one of these out from under us.
//
// Font style rides its own classes because it does NOT come from the same
// theme rule as the colour (textmate resolves the two independently, so the
// combinations aren't enumerable) — and per slot, because a family's two
// themes can disagree (one-light doesn't italicise a parameter one-dark-pro
// does). Both slots are mode-scoped, so no rule leaks across the toggle and
// none needs a reset. Token *background* colours are not carried: they never
// rendered before either (nothing read a span's --shiki-*-bg).
const FONT_RULES = [
  ["i", "font-style:italic"],
  ["b", "font-weight:bold"],
  ["u", "text-decoration:underline"],
  ["s", "text-decoration:line-through"],
  ["us", "text-decoration:underline line-through"],
] as const;

interface Palette {
  lightBg: string;
  darkBg: string;
  lightFg: string;
  darkFg: string;
  // lowercase colour -> class index, per slot.
  light: Map<string, number>;
  dark: Map<string, number>;
  css: string;
}

// A colour we would paste into a stylesheet has to be inert there. Theme JSON
// is ours (Shiki's bundle), so this is belt-and-braces: anything that could end
// a declaration or an element is dropped from the palette, and its tokens take
// the inline fallback instead of writing the rest of the sheet.
const SAFE_COLOR = /^[#\w().,%\-\s]+$/;

// The distinct foregrounds one resolved theme can hand a token: its default
// (`fg` / editor.foreground) first, then every tokenColor's foreground, with
// Shiki's own colorReplacements applied — the same values `codeToTokens` emits.
async function themeColors(id: string): Promise<{ fg: string; bg: string; colors: string[] }> {
  const load = bundledThemes[id as keyof typeof bundledThemes];
  const mod = await load();
  const t = normalizeTheme(mod.default) as ThemeRegistrationResolved;
  const rep = t.colorReplacements;
  const fg = applyColorReplacements(t.fg, rep) || "";
  const bg = applyColorReplacements(t.bg, rep) || "";
  const colors: string[] = [];
  const seen = new Set<string>();
  const add = (c?: string): void => {
    const v = c ? applyColorReplacements(c, rep) : "";
    if (!v || !SAFE_COLOR.test(v)) return;
    const k = v.toLowerCase();
    if (seen.has(k)) return;
    seen.add(k);
    colors.push(v);
  };
  add(fg);
  add(t.colors?.["editor.foreground"]);
  for (const s of t.settings ?? []) add(s.settings?.foreground);
  return { fg, bg, colors };
}

// One palette per resolved theme name — content-independent, so it's built once
// and every render/`themeStyle` call after is a map lookup. `null` marks a theme
// whose data wouldn't load: those renders keep the old inline styles (below),
// which is the one path that still needs `.sx` in main.css.
const paletteCache = new Map<string, Promise<Palette | null>>();

async function buildPalette(light: string, dark: string): Promise<Palette | null> {
  try {
    const [l, d] = await Promise.all([themeColors(light), themeColors(dark)]);
    const rules: string[] = [];
    const index = (colors: string[], prefix: string, mode: string): Map<string, number> => {
      const m = new Map<string, number>();
      colors.forEach((c, i) => {
        m.set(c.toLowerCase(), i);
        rules.push(`${mode} .${prefix}${i}{color:${c}}`);
      });
      return m;
    };
    const lightMap = index(l.colors, "sl", "html:not(.dark)");
    const darkMap = index(d.colors, "sd", "html.dark");
    for (const [suffix, decl] of FONT_RULES) {
      rules.push(`html:not(.dark) .sl${suffix}{${decl}}`);
      rules.push(`html.dark .sd${suffix}{${decl}}`);
    }
    return {
      lightBg: l.bg,
      darkBg: d.bg,
      lightFg: l.fg,
      darkFg: d.fg,
      light: lightMap,
      dark: darkMap,
      css: rules.join("\n"),
    };
  } catch {
    return null;
  }
}

function paletteFor(theme?: string): Promise<Palette | null> {
  const { name, light, dark } = resolveTheme(theme);
  const hit = paletteCache.get(name);
  if (hit) return hit;
  const p = buildPalette(light, dark);
  paletteCache.set(name, p);
  return p;
}

// The resolved theme's own editor background + default foreground, plus the
// palette stylesheet its rendered lines are keyed on. The client paints code
// surfaces with the first two (so a theme looks like it does in an editor) and
// injects the third once as `<style data-r3-theme-css>`. Blanks ⇒ the client
// keeps its neutral surface and the lines render in the surface colour.
export async function themeStyle(theme?: string): Promise<ThemeStyle> {
  const pal = await paletteFor(theme);
  if (!pal) return { lightBg: "", darkBg: "", lightFg: "", darkFg: "", css: "" };
  return {
    lightBg: pal.lightBg,
    darkBg: pal.darkBg,
    lightFg: pal.lightFg,
    darkFg: pal.darkFg,
    css: pal.css,
  };
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

// One slot's classes, or null when the palette can't express this token's colour
// (never seen in practice — the palette is derived from the same theme data the
// tokenizer reads — but a miss must lose the colour, not guess one). An empty
// string means "no class needed": the token wears the theme's default
// foreground, which `.shiki-surface` already paints, so the span inherits it
// exactly as it did when the variable said `inherit`.
function slotClasses(
  style: Record<string, string>,
  slot: "light" | "dark",
  prefix: "sl" | "sd",
  map: Map<string, number>,
  fg: string,
): string | null {
  const v = `--shiki-${slot}`;
  const color = style[v] ?? "";
  let out = "";
  if (color && color !== "inherit" && color.toLowerCase() !== fg.toLowerCase()) {
    const i = map.get(color.toLowerCase());
    if (i === undefined) return null;
    out = `${prefix}${i}`;
  }
  const add = (suffix: string): void => {
    out = out ? `${out} ${prefix}${suffix}` : `${prefix}${suffix}`;
  };
  if (style[`${v}-font-style`] === "italic") add("i");
  if (style[`${v}-font-weight`] === "bold") add("b");
  const dec = style[`${v}-text-decoration`];
  if (dec === "underline") add("u");
  else if (dec === "line-through") add("s");
  else if (dec === "underline line-through") add("us");
  return out;
}

function classesOf(t: ThemedToken, pal: Palette): string | null {
  const s = t.htmlStyle;
  // A string htmlStyle (or none) is the single-theme shape; we always tokenize
  // with a pair, so this is the fallback's business, not the palette's.
  if (!s || typeof s === "string") return null;
  const style = s as Record<string, string>;
  const light = slotClasses(style, "light", "sl", pal.light, pal.lightFg);
  if (light === null) return null;
  const dark = slotClasses(style, "dark", "sd", pal.dark, pal.darkFg);
  if (dark === null) return null;
  return light && dark ? `${light} ${dark}` : light || dark;
}

// One line's inner HTML — the payload itself, so it emits the fewest elements
// that still carry the colours. Shiki splits a token per textmate scope, so a
// line arrives as many neighbours the palette gives the SAME classes (or none):
// a run of those collapses into ONE span, and a run wearing the theme's default
// foreground — class string "" — is emitted as bare text with no wrapper at all,
// since `.shiki-surface` already paints it (that is also the shape the
// unknown-grammar path has always shipped). Exported for the test.
//
// A fallback token (`classesOf` → null) never joins a run: its colour rides an
// inline style, so it keeps its own span exactly as before.
export function tokensToLineHtml(line: ThemedToken[], pal: Palette | null): string {
  if (line.length === 0) return "";
  let out = "";
  // The open run: the class string its tokens share, and their escaped text.
  // `null` = no run open (nothing yet, or the last token was a fallback).
  let runCls: string | null = null;
  let run = "";
  const flush = (): void => {
    if (runCls === null) return;
    out += runCls ? `<span class="${runCls}">${run}</span>` : run;
    runCls = null;
    run = "";
  };
  for (const tok of line) {
    // A zero-length token contributes nothing but would break a run in two.
    if (tok.content.length === 0) continue;
    const cls = pal ? classesOf(tok, pal) : null;
    if (cls === null) {
      flush();
      // Fallback: the pre-palette shape — both colours inline as custom
      // properties, read by main.css's `.sx` rules. Never lose a colour.
      const style = styleOf(tok);
      out += style
        ? `<span class="sx" style="${style}">${escapeHtml(tok.content)}</span>`
        : `<span>${escapeHtml(tok.content)}</span>`;
      continue;
    }
    if (cls !== runCls) flush();
    runCls = cls;
    run += escapeHtml(tok.content);
  }
  flush();
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
//
// TOKENIZE_TIMEOUT_MS is how long the worker may go SILENT with work
// outstanding — one watchdog over the queue, not a deadline per job. The worker
// tokenizes serially, so a per-job clock started at enqueue is really the clock
// of everything ahead of it: a handful of large files (each legitimately seconds
// at ~8-40 ms/KB) would trip the timeout for every job behind the first, drop the
// whole batch to plain text, and tear down a perfectly healthy worker with it.
const TOKENIZE_TIMEOUT_MS = 30_000;

type TokenizeResult = { tokens: ThemedToken[][]; bg?: string; fg?: string };
type HighlightWorker = Worker & { ref(): void; unref(): void };
type Pending = {
  resolve: (r: TokenizeResult) => void;
  reject: (e: Error) => void;
};

let worker: HighlightWorker | null = null;
let workerDisabled = false;
let workerEverOk = false;
let nextTokenizeId = 0;
let watchdog: ReturnType<typeof setTimeout> | null = null;
const pending = new Map<number, Pending>();

// Re-armed on every reply (proof of life) and cleared when the queue drains.
function armWatchdog(): void {
  if (watchdog) clearTimeout(watchdog);
  watchdog = null;
  if (pending.size === 0) return;
  watchdog = setTimeout(() => {
    watchdog = null;
    if (!workerEverOk) workerDisabled = true;
    dropWorker(new Error("highlight worker timeout"));
  }, TOKENIZE_TIMEOUT_MS);
}

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
  if (watchdog) clearTimeout(watchdog);
  watchdog = null;
  const jobs = [...pending.values()];
  pending.clear();
  for (const p of jobs) p.reject(err);
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
  armWatchdog();
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
    pending.set(id, { resolve, reject });
    if (!watchdog) armWatchdog();
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
// line). The spans carry palette classes; their colours arrive once as
// `ThemeStyle.css`. Cached by `cacheKey` (a content sha) — and by theme, which
// is what keeps a body highlighted against one palette from ever being served
// beside another theme's stylesheet.
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
    const pal = await paletteFor(themeName);
    try {
      const { tokens } = await tokenize(code, lang, light, dark);
      lines = tokens.map((l) => tokensToLineHtml(l, pal));
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
  // highlighted body in place of the escaped text. `shiki-code` is the same
  // marker class the code rows carry; the token colours come from the palette
  // classes on the spans (see ThemeStyle.css above).
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
