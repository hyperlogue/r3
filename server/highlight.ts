// Server-side syntax highlighting. We highlight on the server and
// ship HTML/CSS-variable spans to the client, so Shiki's WASM/grammar weight
// never reaches the browser. Dual-theme (light+dark) in one pass via CSS
// variables, and per-blob caching keyed by content sha.

import MarkdownIt from "markdown-it";
import { bundledThemesInfo, codeToTokens, type ThemedToken } from "shiki";
import type { ThemeOption, ThemeStyle } from "../shared/types.ts";

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
function resolveTheme(name?: string): { name: string; light: string; dark: string } {
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
    const r = (await codeToTokens("x", {
      lang: "typescript" as never,
      themes: { light, dark },
      defaultColor: false,
    })) as { bg?: string; fg?: string };
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

export function isMarkdown(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
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

// Bounded LRU so a long-running server doesn't accumulate the highlighted copy
// of every blob ever rendered. Map iteration order is insertion order, so the
// first key is the least-recently-used.
const LINE_CACHE_MAX = 512;
const lineCache = new Map<string, string[]>();
function cacheGet(key: string): string[] | undefined {
  const v = lineCache.get(key);
  if (v) {
    lineCache.delete(key);
    lineCache.set(key, v);
  }
  return v;
}
function cacheSet(key: string, v: string[]): void {
  lineCache.set(key, v);
  if (lineCache.size > LINE_CACHE_MAX) {
    const oldest = lineCache.keys().next().value;
    if (oldest !== undefined) lineCache.delete(oldest);
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
  if (!lang) {
    lines = code.split("\n").map((l) => escapeHtml(l));
  } else {
    try {
      const { tokens } = await codeToTokens(code, {
        lang: lang as never,
        themes: { light, dark },
        defaultColor: false,
      });
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

// ---- Markdown render with per-block source-line mapping. Each top-level token
// gets data-line-start/end so the client can anchor feedback to a
// heading/paragraph/code-fence by source line. ----

const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

// Inject data-line attributes from token.map onto block-level open tokens.
md.core.ruler.push("line_numbers", (state) => {
  for (const token of state.tokens) {
    if (token.map && token.level === 0 && token.type.endsWith("_open")) {
      token.attrSet("data-line-start", String(token.map[0] + 1));
      token.attrSet("data-line-end", String(token.map[1]));
    }
    // fences are self-contained (no _open/_close) — tag them directly
    if (token.map && token.level === 0 && token.type === "fence") {
      token.attrSet("data-line-start", String(token.map[0] + 1));
      token.attrSet("data-line-end", String(token.map[1]));
    }
  }
  return true;
});

export function renderMarkdown(source: string): string {
  return md.render(source);
}
