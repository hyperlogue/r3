import { type BundledLanguage, bundledLanguages, bundledLanguagesInfo } from "shiki";
import fileTypes from "./highlight-file-types.gen.json";

// Keep the existing extension spellings for Markdown fences and preserve the
// source defaults established before the full filename index.
const EXT_LANG: Record<string, BundledLanguage> = {
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
  ex: "elixir",
  exs: "elixir",
  heex: "html",
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

// Some upstream grammars omit fileTypes. Fill common gaps and explicitly choose
// defaults for shared extensions; filename detection cannot distinguish dialects.
const PATH_OVERRIDES: Record<string, BundledLanguage> = {
  adb: "ada",
  ads: "ada",
  bib: "bibtex",
  cljc: "clojure",
  cljs: "clojure",
  cljx: "clojure",
  edn: "clojure",
  hh: "cpp",
  hxx: "cpp",
  cxx: "cpp",
  cts: "typescript",
  mts: "typescript",
  env: "dotenv",
  fnl: "fennel",
  fsi: "fsharp",
  fsx: "fsharp",
  gni: "gn",
  gradle: "groovy",
  gvy: "groovy",
  gy: "groovy",
  gsh: "groovy",
  gs: "glsl",
  htm: "html",
  hlsli: "hlsl",
  j2: "jinja",
  jinja2: "jinja",
  ndjson: "jsonl",
  libsonnet: "jsonnet",
  ll: "llvm",
  mk: "make",
  mak: "make",
  mdown: "markdown",
  markdown: "markdown",
  mkd: "markdown",
  m: "objective-c",
  mm: "objective-cpp",
  nimble: "nim",
  pl: "perl",
  pm: "perl",
  t: "perl",
  pp: "puppet",
  psm1: "powershell",
  psd1: "powershell",
  pxd: "python",
  pxi: "python",
  pyx: "python",
  pyi: "python",
  pyw: "python",
  rkt: "racket",
  rktd: "racket",
  rktl: "racket",
  raku: "raku",
  rakumod: "raku",
  rakutest: "raku",
  p6: "raku",
  pl6: "raku",
  pm6: "raku",
  sc: "scala",
  ss: "scheme",
  bashrc: "shellscript",
  bash_profile: "shellscript",
  bash_login: "shellscript",
  bash_logout: "shellscript",
  zshrc: "shellscript",
  zshenv: "shellscript",
  zprofile: "shellscript",
  zlogin: "shellscript",
  zlogout: "shellscript",
  profile: "shellscript",
  service: "systemd",
  socket: "systemd",
  timer: "systemd",
  target: "systemd",
  mount: "systemd",
  automount: "systemd",
  path: "systemd",
  slice: "systemd",
  swap: "systemd",
  vbhtml: "razor",
  vbs: "vb",
  bas: "vb",
  vh: "verilog",
  vsh: "glsl",
  vimrc: "viml",
  gvimrc: "viml",
  "vine.ts": "vue-vine",
  wat: "wasm",
  wast: "wasm",
  xsd: "xml",
  xsl: "xsl",
  xslt: "xsl",
  svg: "xml",
  plist: "xml",
  conf: "ini",
  cfg: "ini",
  patch: "diff",
};

const FILENAMES: Record<string, BundledLanguage> = {
  dockerfile: "docker",
  containerfile: "docker",
  makefile: "make",
  gnumakefile: "make",
  "makefile.am": "make",
  "makefile.in": "make",
  "cmakelists.txt": "cmake",
  gemfile: "ruby",
  rakefile: "ruby",
  guardfile: "ruby",
  brewfile: "ruby",
  vagrantfile: "ruby",
  jenkinsfile: "groovy",
  "cargo.lock": "toml",
  "go.mod": "go",
  "go.sum": "go",
  "go.work": "go",
  commit_editmsg: "git-commit",
  merge_msg: "git-commit",
  "git-rebase-todo": "git-rebase",
};

// Use only metadata at startup. Loading all grammars to discover fileTypes would
// defeat Shiki's lazy loading and keep every grammar resident in the daemon.
const pathLanguages = new Map<string, string>();
const candidates = new Map<string, Set<string>>();
for (const [id, types] of Object.entries(fileTypes.languages)) {
  for (const type of types) {
    const key = type.toLowerCase().replace(/^\./, "");
    const ids = candidates.get(key) ?? new Set<string>();
    ids.add(id);
    candidates.set(key, ids);
  }
}
for (const [key, ids] of candidates) {
  // Shared spellings need an explicit default below, not registry-order wins.
  if (ids.size === 1) pathLanguages.set(key, [...ids][0]);
}
for (const { id, aliases } of bundledLanguagesInfo) {
  for (const key of [id, ...(aliases ?? [])]) pathLanguages.set(key.toLowerCase(), id);
}
for (const [key, id] of Object.entries({ ...PATH_OVERRIDES, ...EXT_LANG })) {
  pathLanguages.set(key, id);
}
// Shiki handles ANSI output as a special language outside its grammar registry.
pathLanguages.set("ansi", "ansi");

export function langForPath(path: string): string | null {
  const normalized = path.toLowerCase();
  const base = normalized.split("/").pop() ?? "";
  if (!base) return null;
  if (Object.hasOwn(FILENAMES, base)) return FILENAMES[base];
  if (base.startsWith(".env.")) return "dotenv";
  if (base.startsWith("dockerfile.") || base.startsWith("containerfile.")) return "docker";
  if (normalized === ".ssh/config" || normalized.endsWith("/.ssh/config")) return "ssh-config";

  // Whole filenames and compound suffixes win over their shorter extensions:
  // nginx.conf → nginx, template.blade.php → blade, component.vue → vue.
  let suffix = base.replace(/^\./, "");
  while (suffix) {
    const language = pathLanguages.get(suffix);
    if (language) return language;
    const dot = suffix.indexOf(".");
    if (dot === -1) break;
    suffix = suffix.slice(dot + 1);
  }
  return null;
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
