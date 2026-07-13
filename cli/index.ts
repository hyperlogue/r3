#!/usr/bin/env bun
// r3 CLI — a thin HTTP client to the per-user daemon. This is
// the agent's entry point: it both *creates* reviews (returns a URL to surface in
// chat) and *replies/re-anchors* on them. It discovers the daemon via an XDG
// `daemon.json` (or R3_URL), and lazily spawns one — à la tmux — on the first
// call when none is healthy. Lifecycle: `r3 start | stop | status | restart`.

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { type DaemonInfo, R3_VERSION, readDaemonJson, removeDaemonJson } from "../server/config.ts";
import { SUMMARY_FILE } from "../shared/types.ts";

interface ServerInfo {
  url: string;
  token: string;
  root: string; // worktree root the CLI's paths are relative to
  repoHeader: string | null; // x-r3-repo: base64 descriptor of the CLI's checkout
}

// Compute the x-r3-repo header from the CLI's own checkout:
// the common-dir (project identity) + worktree descriptor, so the daemon knows
// which project/worktree this call targets and auto-registers it on first use.
function repoHeader(): { header: string | null; root: string } {
  const root = findRepoRoot();
  try {
    const r = Bun.spawnSync(
      [
        "git",
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--show-toplevel",
        "--git-dir",
        "--abbrev-ref",
        "HEAD",
      ],
      { cwd: process.cwd() },
    );
    if (r.exitCode !== 0) return { header: null, root };
    const [commonDir, toplevel, gitDir, branch] = r.stdout.toString().trim().split("\n");
    if (!commonDir || !toplevel) return { header: null, root };
    const real = (p: string) => {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    };
    const payload = {
      commonDir: real(commonDir),
      worktreePath: real(toplevel),
      name: gitDir?.includes("/worktrees/") ? basename(gitDir) : "",
      branch: branch || null,
    };
    return {
      header: Buffer.from(JSON.stringify(payload)).toString("base64"),
      root: real(toplevel),
    };
  } catch {
    return { header: null, root };
  }
}

interface Health {
  ok: boolean;
  version: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function findRepoRoot(): string {
  let dir = resolve(process.cwd());
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return resolve(process.cwd());
    dir = parent;
  }
}

// GET /api/health, or null if the daemon isn't answering.
async function probe(url: string): Promise<Health | null> {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? ((await r.json()) as Health) : null;
  } catch {
    return null;
  }
}

// The compiled binary carries the bundled SPA as embedded files (the daemon's
// `import index from "../web/index.html"` is baked in at compile time); a
// from-source run has none. This is how we tell the two apart.
function isCompiled(): boolean {
  return Bun.embeddedFiles.length > 0;
}

// How to (re)launch the daemon: the compiled binary re-execs itself with the
// hidden `__daemon` subcommand; from source we re-run this script under bun.
function daemonArgv(): string[] {
  return isCompiled() ? [process.execPath, "__daemon"] : [process.execPath, Bun.main, "__daemon"];
}

// Spawn the daemon detached and wait for it to come up healthy. The O_EXCL
// daemon.lock pidfile is the lock: if two CLI calls race, the loser exits 0 and
// the winner's daemon.json is what we poll for here.
async function spawnDaemon(): Promise<DaemonInfo> {
  const [bin, ...rest] = daemonArgv();
  // The daemon is repo-agnostic: every request self-describes its repo (the CLI's
  // x-r3-repo header, a review id, or a browser ?repo selector), so the spawn
  // passes no "default repo". cwd matters only from source: run in the r3 repo so
  // Bun finds its bunfig.toml — which registers bun-plugin-tailwind for
  // Bun.serve's static SPA bundling. Bun resolves bunfig.toml from the cwd, so
  // spawned in an arbitrary user repo (the usual lazy-spawn case) it wouldn't find
  // it, the SPA's `@import "tailwindcss"` would fail to bundle, and `/` would serve
  // an empty page. The compiled binary embeds the SPA (no bundling, no bunfig), so
  // its cwd is irrelevant — inherit ours.
  const cwd = isCompiled() ? process.cwd() : resolve(dirname(Bun.main), "..");
  const proc = Bun.spawn([bin, ...rest], {
    cwd,
    // R3_DETACHED tells the daemon to ignore SIGINT too: it stays in our process
    // group, so a Ctrl-C in the terminal during the spawn window would otherwise
    // SIGINT-kill the daemon we just started. It's stopped via `r3 stop` (SIGTERM).
    env: { ...process.env, R3_DETACHED: "1" },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  proc.unref();
  for (let i = 0; i < 100; i++) {
    await sleep(50);
    const d = readDaemonJson();
    if (d && (await probe(d.url))) return d;
  }
  fail("daemon failed to start (no healthy daemon.json after 5s)");
}

// Resolve a usable daemon: honour R3_URL, reuse a healthy one, else lazy-spawn.
// Warns on CLI/daemon version skew (a stale daemon after a binary upgrade).
async function ensureServer(): Promise<ServerInfo> {
  const { header, root } = repoHeader();
  if (process.env.R3_URL) {
    return {
      url: process.env.R3_URL,
      token: process.env.R3_TOKEN ?? readDaemonJson()?.token ?? "",
      root,
      repoHeader: header,
    };
  }
  let info = readDaemonJson();
  let health = info ? await probe(info.url) : null;
  if (!info || !health) {
    info = await spawnDaemon();
    health = await probe(info.url);
  }
  if (health && health.version !== R3_VERSION) {
    process.stderr.write(
      `r3: warning — daemon is v${health.version} but this CLI is v${R3_VERSION}; ` +
        "run `r3 restart` to upgrade.\n",
    );
  }
  return { url: info.url, token: info.token, root, repoHeader: header };
}

// Turn a user-supplied path into the repo-relative path the server understands.
// A path can be given relative to the shell's cwd or (commonly, when copied from
// a prompt) relative to the repo root; we disambiguate by which one exists on
// disk, preferring the cwd interpretation.
function repoRel(abs: string): string | null {
  const rel = relative(SERVER.root, abs).split(sep).join("/");
  return rel.startsWith("..") ? null : rel;
}
function toRepoRelative(p: string): string {
  const cwdAbs = resolve(process.cwd(), p);
  if (existsSync(cwdAbs)) return repoRel(cwdAbs) ?? p;
  const rootAbs = resolve(SERVER.root, p);
  if (existsSync(rootAbs)) return repoRel(rootAbs) ?? p;
  return repoRel(cwdAbs) ?? p;
}

// Glob metacharacters that turn a `--files` token into a pattern; without any,
// the token is a literal path resolved cwd-relative like before.
const GLOB_MAGIC = /[*?[\]{}]/;

// The repo's "git set": tracked files plus new untracked ones, minus anything
// .gitignored. This is what globs match against (so `**/*.ts` never pulls in
// node_modules/ or dist/). Paths are repo-root-relative, forward-slashed.
function gitTrackedFiles(): string[] {
  const r = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: SERVER.root,
  });
  if (r.exitCode !== 0) {
    fail(`git ls-files failed: ${r.stderr.toString().trim() || "non-zero exit"}`);
  }
  return r.stdout.toString().split("\0").filter(Boolean);
}

// Expand `--files` tokens into a concrete, deduped, repo-relative file list.
// A token with glob metacharacters is matched (shell-glob semantics: `*` stays
// within a path segment, `**` spans them) against the git set, repo-root-anchored;
// a plain path is kept as-is, cwd-relative. Empty result is a hard error.
function expandFileArgs(patterns: string[]): string[] {
  let tracked: string[] | null = null;
  const out = new Set<string>();
  for (const pat of patterns) {
    if (!GLOB_MAGIC.test(pat)) {
      out.add(toRepoRelative(pat));
      continue;
    }
    tracked ??= gitTrackedFiles();
    const glob = new Bun.Glob(pat);
    let matched = 0;
    for (const f of tracked) {
      if (glob.match(f)) {
        out.add(f);
        matched++;
      }
    }
    if (matched === 0) process.stderr.write(`r3: warning — no files match '${pat}'\n`);
  }
  if (out.size === 0) fail("--files matched no files");
  return [...out];
}

function fail(msg: string): never {
  console.error(`r3: ${msg}`);
  process.exit(1);
}

// Assigned by ensureServer() in main(), before any command that calls api().
let SERVER: ServerInfo;

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-r3-token": SERVER.token,
  };
  if (SERVER.repoHeader) headers["x-r3-repo"] = SERVER.repoHeader;
  const r = await fetch(SERVER.url + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) fail(`${method} ${path} → ${r.status}: ${text}`);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// A feedback is awaiting the agent when it holds content the agent hasn't been
// sent yet — mirrors the server's unsent predicate (prompt.ts hasUnsentContent):
// never delivered (only while still open — a note resolved before any hand-off
// was settled without the agent), or a human reply / undelivered status flip
// (bare Resolve/Reopen) landed since the last hand-off. This is delivery state
// (sent_at + status_unsent), not a last-speaker heuristic — so a restarted
// `watch` no longer re-emits items already delivered (that's the point;
// `r3 show` recovers the full history).
function awaitingAgent(fb: any): boolean {
  if (fb.sent_at == null) return fb.status === "open";
  return fb.replies.some((r: any) => r.author === "human" && !r.sent_at) || !!fb.status_unsent;
}

async function awaitingIds(id: string): Promise<string[]> {
  const detail = await api("GET", `/api/reviews/${id}`);
  return detail.feedback.filter(awaitingAgent).map((f: any) => f.id);
}

// Read the server's SSE stream and call `onEvent(name)` per event, reconnecting
// if it drops. `session` (display string) registers us as a live watcher on the
// review (so the web UI shows who's watching and offers Submit instead of Copy);
// `agentId` is a precise machine handle other tools can use to find this agent.
async function streamEvents(
  id: string,
  session: string,
  agentId: string | undefined,
  onEvent: (name: string) => void,
  signal: AbortSignal,
): Promise<void> {
  let url = `${SERVER.url}/api/events?review=${encodeURIComponent(id)}&session=${encodeURIComponent(session)}`;
  if (agentId) url += `&agentId=${encodeURIComponent(agentId)}`;
  while (!signal.aborted) {
    try {
      const r = await fetch(url, { headers: { "x-r3-token": SERVER.token }, signal });
      if (!r.ok || !r.body) throw new Error(`events ${r.status}`);
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl: number = buf.indexOf("\n\n");
        while (nl !== -1) {
          const block = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          let name = "message";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) name = line.slice(6).trim();
          }
          onEvent(name);
          nl = buf.indexOf("\n\n");
        }
      }
    } catch {
      if (signal.aborted) return;
    }
    await sleep(1000); // reconnect backoff
  }
}

// ---- tiny arg parser: flags (--k v / --k), repeatable (--meta k=v), positionals ----
interface Args {
  positional: string[];
  flags: Record<string, string | true>;
  multi: Record<string, string[]>;
}

const MULTI = new Set(["meta"]);
// `--files` is greedy: it swallows every remaining token as a path/glob, so it
// must come last on the line (after --title/--meta/--ref). This is what makes
// `--files $(git ls-files)` and `--files 'server/**/*.ts' '*.md'` both work.
const REST = new Set(["files"]);
const BOOL = new Set(["working", "staged", "scratch", "stdin-diff", "json", "all"]);
// Value flags whose argument is numeric/structured (a seq, a `a-b` range, a
// count of seconds, a `base..head`, a ref/sha, a status enum, a fid list) — none
// of which can legitimately start with "-". So a following "-…" token is always a
// mistakenly-omitted value, never the value itself; parseArgs rejects it instead
// of silently swallowing the next flag (e.g. `--timeout --json`). Free-form value
// flags (-m/--title/--label/--summary/--quote/--session/--agent-id/--file) are
// deliberately NOT here, so a value that legitimately begins with "-" still works.
const TYPED = new Set([
  "diff",
  "line",
  "timeout",
  "auto-fetch-timeout",
  "commit",
  "status",
  "feedback",
  "ref",
  "side",
]);

// Pull the value that follows a value flag at argv[i]. Two guards keep a flag
// from silently swallowing the wrong token — both are hard failures, never a
// silent coercion:
//   1. No following token (flag ends the line): `r3 create --title` would store
//      `undefined` and crash a later `.split`/`Number`. Always an error.
//   2. For TYPED flags only, a following token that is itself a flag ("-…") can
//      only be a mistakenly-omitted value, so `--timeout --json` must not become
//      timeout="--json" (silently dropping --json). Free-form flags are exempt
//      (their values may legitimately start with "-"), so only guard (1) applies
//      to them — e.g. `--title --working` still stores title="--working".
function takeValue(argv: string[], i: number, key: string): string {
  const label = key.startsWith("-") ? key : `--${key}`;
  const v = argv[i + 1];
  if (v === undefined) fail(`${label} expects a value`);
  if (TYPED.has(key) && v.startsWith("-")) fail(`${label} expects a value (got the flag "${v}")`);
  return v;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { positional: [], flags: {}, multi: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      if (REST.has(key)) {
        const rest = argv.slice(i + 1);
        for (const t of rest) {
          if (t.startsWith("--")) {
            process.stderr.write(
              `r3: warning — --${key} consumes all remaining args, so "${t}" is treated ` +
                `as a path, not a flag; put flags before --${key}.\n`,
            );
          }
        }
        out.multi[key] = rest;
        break;
      }
      if (BOOL.has(key)) {
        out.flags[key] = true;
      } else if (MULTI.has(key)) {
        out.multi[key] ??= [];
        out.multi[key].push(argv[++i]);
      } else {
        out.flags[key] = takeValue(argv, i, key);
        i++;
      }
    } else if (a === "-m") {
      out.flags.message = takeValue(argv, i, "-m");
      i++;
    } else {
      out.positional.push(a);
    }
  }
  return out;
}

function metaObject(pairs: string[] | undefined): Record<string, string> {
  const m: Record<string, string> = {};
  for (const p of pairs ?? []) {
    // A bare `--meta` at the end of the line pushes `argv[++i]` === undefined into
    // multi.meta; `!p` catches that (and an empty entry) so we fail cleanly rather
    // than throw a raw TypeError from `.indexOf` on undefined.
    if (!p) fail("--meta expects k=v (key=value), e.g. --meta session=abc");
    const eq = p.indexOf("=");
    if (eq === -1) fail(`--meta expects k=v, got "${p}"`);
    m[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return m;
}

function printReview(r: any) {
  console.log(`${r.id}  ${r.status}  ${r.kind}  ${r.title ?? ""}`);
  if (r.url) console.log(`  ${r.url}`);
}

// ---- commands ----

async function cmdCreate(args: Args) {
  // A review must bind to the actor's own repo, carried by the x-r3-repo header.
  // Outside a git repo there is none, and the daemon (repo-agnostic) would answer
  // "no repo context"; fail loudly here instead.
  if (!SERVER.repoHeader) fail("`r3 create` must be run inside a git repository");
  const meta = metaObject(args.multi.meta);
  const title = (args.flags.title as string) ?? null;
  const summary = (args.flags.summary as string) ?? null;

  // Adhoc scratch review: an empty review + a per-review directory the agent drops
  // files into. The daemon watches that directory, so the files appear in the
  // review live — no upload step. The directory path is printed (3rd line); use
  // exactly that path, don't guess it.
  if (args.flags.scratch) {
    const res = await api("POST", "/api/reviews", {
      scratch: true,
      meta,
      title,
      summary,
      created_by: "agent",
    });
    console.log(res.id);
    console.log(res.url);
    console.log(res.scratchDir); // put files here; they load into the review live
    return;
  }

  // Piped diff review: store whatever unified diff arrives on stdin as round 1 —
  // the daemon never consults git for it. `git diff X..Y | r3 create --stdin-diff`.
  if (args.flags["stdin-diff"]) {
    const patch = await Bun.stdin.text();
    if (!patch.trim()) fail("create --stdin-diff expects a unified diff on stdin");
    const res = await api("POST", "/api/reviews", {
      kind: "diff",
      patch,
      label: (args.flags.label as string) ?? null,
      meta,
      title,
      summary,
      created_by: "agent",
    });
    console.log(res.id);
    console.log(res.url);
    return;
  }

  let kind: "diff" | "files";
  let source: unknown;

  if (args.flags.commit) {
    const sha = args.flags.commit as string;
    kind = "diff";
    source = { base: `${sha}^`, head: sha };
  } else if (args.flags.diff) {
    const [base, head] = (args.flags.diff as string).split("..");
    if (!base || !head) fail("--diff expects <base>..<head>");
    kind = "diff";
    source = { base, head };
  } else if (args.flags.working) {
    kind = "diff";
    source = { base: "HEAD", head: "WORKING" };
  } else if (args.flags.staged) {
    kind = "diff";
    source = { base: "HEAD", head: "STAGED" };
  } else if (args.multi.files?.length) {
    kind = "files";
    source = {
      ref: (args.flags.ref as string) ?? "WORKING",
      files: expandFileArgs(args.multi.files),
    };
  } else {
    fail(
      "create needs one of: --commit <sha> | --diff <base>..<head> | --working | --staged | --stdin-diff | --files <path>... | --scratch",
    );
  }

  const res = await api("POST", "/api/reviews", {
    kind,
    source,
    meta,
    title,
    summary,
    created_by: "agent",
  });
  console.log(res.id);
  console.log(res.url);
}

async function cmdList(args: Args) {
  const q = new URLSearchParams();
  if (args.flags.status) q.set("status", args.flags.status as string);
  for (const [k, v] of Object.entries(metaObject(args.multi.meta))) q.set(`meta.${k}`, v);
  const reviews = await api("GET", `/api/reviews?${q.toString()}`);
  if (!reviews.length) {
    console.log("(no reviews)");
    return;
  }
  for (const r of reviews) printReview(r);
}

async function cmdShow(args: Args) {
  const id = args.positional[0] ?? fail("show <id>");
  const detail = await api("GET", `/api/reviews/${id}`);
  if (args.flags.json) {
    console.log(JSON.stringify(detail, null, 2));
    return;
  }
  printReview(detail);
  if (detail.summary?.trim()) {
    console.log(`  summary: ${detail.summary.trim().replace(/\n/g, "\n           ")}`);
  }
  if (detail.patches?.length > 1) {
    const rounds = detail.patches
      .map((p: any) => `${p.seq}${p.label ? ` (${p.label})` : ""}`)
      .join(", ");
    console.log(`  diffs: ${rounds}`);
    for (const p of detail.patches) {
      if (p.summary)
        console.log(`    diff ${p.seq}: ${p.summary.replace(/\n/g, "\n             ")}`);
    }
  }
  for (const fb of detail.feedback) {
    const stale = fb.anchor === "outdated" ? " ⚠outdated" : "";
    let target: string;
    if (fb.file === SUMMARY_FILE) {
      // Anchored to prose, not a file — name which summary (round or review).
      target = fb.patch_seq != null ? `diff ${fb.patch_seq} summary` : "review summary";
    } else {
      const loc = fb.line_start
        ? `:L${fb.line_start}${fb.line_end && fb.line_end !== fb.line_start ? `-${fb.line_end}` : ""}`
        : fb.file
          ? " (whole file)" // a real path with no span — anchored to the file itself
          : "";
      const round = fb.patch_seq != null ? ` [diff ${fb.patch_seq}]` : "";
      target = `${fb.file}${loc}${round}`;
    }
    console.log(`\n  ${fb.id} [${fb.status}]${stale} ${target}`);
    console.log(`    ${fb.body.replace(/\n/g, "\n    ")}`);
    for (const rp of fb.replies) {
      const pin =
        rp.patch_seq != null
          ? ` [diff ${rp.patch_seq}${rp.file ? ` ${rp.file}${rp.line_start ? `:L${rp.line_start}` : ""}` : ""}]`
          : "";
      console.log(`      ↳ ${rp.author}${pin}: ${rp.body}`);
    }
  }
}

// The agent prompt for a review. Default POSTs: it prints only feedback the
// agent hasn't seen yet (new items, human follow-ups, resolutions) and marks it
// delivered, so the next call won't repeat it. `--all` GETs and re-prints every
// open item (already-delivered ones included) and marks nothing — the escape
// hatch; for the true full history (resolved too) use `r3 show`. `--feedback`
// narrows to a comma-separated subset of ids.
async function cmdPrompt(args: Args) {
  const id = args.positional[0] ?? fail("prompt <id> [--all] [--feedback <fid,...>]");
  const feedback = args.flags.feedback
    ? String(args.flags.feedback)
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  if (args.flags.all) {
    const q = feedback ? `?feedback=${feedback.join(",")}` : "";
    console.log(await api("GET", `/api/reviews/${id}/prompt${q}`));
    return;
  }
  console.log(await api("POST", `/api/reviews/${id}/prompt`, feedback ? { feedback } : {}));
}

// `r3 watch` exit codes, so a wrapping agent loop can branch on the outcome:
//   0  = review APPROVED — the human accepted the work (any "next steps" note is
//        printed to stdout). Terminal success; stop looping.
//   10 = the human SUBMITTED feedback — the prompt is on stdout; act on it, reply,
//        then `r3 watch` again for the next round.
//   2  = timed out (no Submit within --timeout).
//   3  = review ABANDONED — closed without approval; stop looping.
const WATCH_EXIT = { approved: 0, feedback: 10, timeout: 2, abandoned: 3 } as const;

// Block until the human hits Submit in the web UI, then print the agent prompt
// for the awaiting items so the coding agent can act without copy-paste. While
// watching we register as a live watcher so the UI shows who's listening and
// offers Submit instead of Copy. `--auto-fetch-timeout <sec>` opts into an
// auto-send debounce (for flows with no human to click Submit); the default
// waits for Submit.
async function cmdWatch(args: Args) {
  const id =
    args.positional[0] ??
    fail(
      "watch <id> [--session <name>] [--agent-id <id>] [--auto-fetch-timeout <sec>] [--timeout <sec>]",
    );
  // Auto-send debounce: 0/absent = off (wait for Submit). When > 0, also emit
  // after the awaiting set has been quiet this long. A present-but-non-numeric
  // value must fail loudly — coercing garbage to NaN would silently disable
  // auto-fetch (NaN > 0 is false) instead of doing what was asked.
  const autoFetchRaw = args.flags["auto-fetch-timeout"];
  const autoFetchSec = autoFetchRaw === undefined ? 0 : Number(autoFetchRaw);
  if (!Number.isFinite(autoFetchSec) || autoFetchSec < 0)
    fail("--auto-fetch-timeout expects a non-negative number of seconds");
  const autoFetchMs = autoFetchSec * 1000;
  // Give-up deadline in seconds; default 0 = never (block until the human acts),
  // matching the agent loop where each `watch` waits for the next round. Pass a
  // positive `--timeout <sec>` for a bounded wait; reject negative/garbage. An
  // empty/whitespace value (e.g. an unset `--timeout "$FOO"`) is treated as "not
  // provided" and falls back to the default.
  const timeoutRaw = typeof args.flags.timeout === "string" ? args.flags.timeout.trim() : "";
  let timeoutSec = 0;
  if (timeoutRaw !== "") {
    timeoutSec = Number(timeoutRaw);
    if (!Number.isFinite(timeoutSec) || timeoutSec < 0)
      fail("--timeout expects a non-negative number of seconds (0 = never)");
  }
  const timeoutMs = timeoutSec * 1000;
  const startedAt = Date.now();

  // The review left `open` — the human approved or abandoned it (maybe out from
  // under a live watch). Approved is the happy exit (0) and carries any "next
  // steps" note to stdout for the agent; abandoned exits 3. Either way stop.
  const finishClosed = (detail: any): never => {
    if (detail.status === "approved") {
      const note = ((detail.meta?.next_steps as string) ?? "").trim();
      process.stderr.write(
        `\nr3: review ${id} approved — ${note ? "next steps from the human:" : "nothing further to do."}\n`,
      );
      if (note) console.log(`\n${note}`);
      process.exit(WATCH_EXIT.approved);
    }
    process.stderr.write(`r3: review ${id} is ${detail.status} — nothing to answer.\n`);
    process.exit(WATCH_EXIT.abandoned);
  };

  const detail0 = await api("GET", `/api/reviews/${id}`);
  // Already closed out — nothing to block on. Split approved (0) from abandoned
  // (3) so a wrapping loop knows whether the work was accepted.
  if (detail0.status !== "open") finishClosed(detail0);
  const session = (args.flags.session as string) ?? detail0.meta?.session ?? "agent";
  const agentId = (args.flags["agent-id"] as string) ?? undefined;

  const emit = async (ids: string[]) => {
    process.stderr.write(
      `\nr3: ${ids.length} feedback item${ids.length === 1 ? "" : "s"} from the human.\n\n`,
    );
    // POST marks these delivered so a later `watch`/`prompt` won't re-emit them.
    console.log(await api("POST", `/api/reviews/${id}/prompt`, { feedback: ids }));
  };

  // Debounce (only when --auto-fetch-timeout is set): wait, re-check, keep
  // waiting while the awaiting set is still growing so a burst emits as one batch.
  const settle = async (ids: string[]): Promise<string[]> => {
    let cur = ids;
    while (autoFetchMs > 0) {
      await sleep(autoFetchMs);
      const next = await awaitingIds(id);
      if (next.length <= cur.length) return next.length ? next : cur;
      cur = next;
    }
    return cur;
  };

  // Pick up anything already waiting (left before this watch, or after a restart).
  const pending = detail0.feedback.filter(awaitingAgent).map((f: any) => f.id);
  if (pending.length) {
    await emit(autoFetchMs > 0 ? await settle(pending) : pending);
    process.exit(WATCH_EXIT.feedback);
  }

  process.stderr.write(
    `r3: watching ${id} as "${session}" — waiting for you to Submit.  (Ctrl-C to stop)\n` +
      `    ${SERVER.url}/${id}\n`,
  );
  const controller = new AbortController();
  let submitted = false;
  let wake: () => void = () => {};
  streamEvents(
    id,
    session,
    agentId,
    (name) => {
      if (name === "submitted") submitted = true;
      wake();
    },
    controller.signal,
  );

  for (;;) {
    if (timeoutMs && Date.now() - startedAt > timeoutMs) {
      controller.abort();
      process.stderr.write("r3: watch timed out.\n");
      process.exit(WATCH_EXIT.timeout);
    }
    const waitMs = timeoutMs
      ? Math.min(30000, Math.max(1, timeoutMs - (Date.now() - startedAt)))
      : 30000;
    await Promise.race([new Promise<void>((r) => (wake = r)), sleep(waitMs)]);
    const detail = await api("GET", `/api/reviews/${id}`);
    // The human can close the review out from under us (approve/abandon); stop
    // waiting once it's no longer open — approved exits 0 (+ next steps), else 3.
    if (detail.status !== "open") {
      controller.abort();
      finishClosed(detail);
    }
    const ids = detail.feedback.filter(awaitingAgent).map((f: any) => f.id);
    if (!ids.length) continue;
    if (submitted) {
      controller.abort();
      await emit(ids);
      process.exit(WATCH_EXIT.feedback);
    }
    if (autoFetchMs > 0) {
      const settled = await settle(ids);
      if (settled.length) {
        controller.abort();
        await emit(settled);
        process.exit(WATCH_EXIT.feedback);
      }
    }
  }
}

async function cmdReply(args: Args) {
  // The agent addresses a feedback by its globally-unique id; no review id or
  // action — a reply is just a reply, its intent lives in the prose. The human
  // still resolves/reopens feedback from the web UI.
  const fid =
    args.positional[0] ??
    fail('reply <feedback_id> -m "<msg>" [--diff <seq> --file <f> --line <a-b> [--quote <text>]]');
  // A reply is always a plain message: by design the human drives status
  // (resolve/reopen) from the UI. Reject the old action flags loudly so a stale
  // `r3 reply <fid> --accept` fails instead of silently succeeding with the
  // feedback status unchanged.
  const reserved = ["accept", "refute", "followup", "resolve"].filter((k) => k in args.flags);
  if (reserved.length)
    fail(
      `reply doesn't take --${reserved[0]} — a reply is always a plain message; ` +
        "the human resolves feedback from the UI. Say what you " +
        'did in -m "…" and let them decide.',
    );
  const message = (args.flags.message as string) ?? fail("reply needs -m <message>");
  const body: Record<string, unknown> = { author: "agent", body: message };
  // Anchored reply: pin where the change addressing this feedback landed in a
  // stored diff round (diff reviews). The feedback keeps pointing at
  // what the human commented on; this points at the fix.
  if (args.flags.diff !== undefined) {
    const seq = Number(args.flags.diff);
    if (!Number.isInteger(seq) || seq < 1) fail("reply --diff expects a round number (seq ≥ 1)");
    body.patchSeq = seq;
    if (args.flags.file) body.file = toRepoRelative(args.flags.file as string);
    if (args.flags.line) {
      const [a, b] = (args.flags.line as string).split("-");
      const lineStart = Number(a);
      const lineEnd = Number(b ?? a);
      if (
        !Number.isInteger(lineStart) ||
        lineStart < 1 ||
        !Number.isInteger(lineEnd) ||
        lineEnd < lineStart
      )
        fail("reply --line expects <a-b> with integer line numbers a ≤ b (≥ 1)");
      body.lineStart = lineStart;
      body.lineEnd = lineEnd;
    }
    if (args.flags.quote) body.quote = args.flags.quote;
  }
  await api("POST", `/api/feedback/${fid}/replies`, body);
  console.log(
    `replied to ${fid}${body.patchSeq != null ? ` (pinned to diff ${body.patchSeq})` : ""}`,
  );
}

// ---- agent-authored feedback: r3 feedback add ----

// Open a feedback item as the agent — the same entity the human's notes use
// (same anchors, same thread, same open/resolved lifecycle), pointed the other
// way: guide the human to the spots that matter, ask a question, flag a risk.
// Three anchor shapes, like the UI's: review-level (no --file), whole-file
// (--file only), line-anchored (--file + --line; the server derives the quote —
// the anchor of record — from the round/live content when --quote is omitted).
// Agent feedback is born delivered: it never echoes back in your own prompts,
// but the human's replies and resolution do (watch/prompt as usual).
async function cmdFeedback(args: Args) {
  const usage =
    'feedback add <review_id> -m "<msg>" [--file <f> [--line <a-b>] [--quote "<text>"] ' +
    "[--side old|new]] [--diff <seq>]";
  const sub = args.positional[0];
  if (sub !== "add") fail(usage);
  const id = args.positional[1] ?? fail(usage);
  const message = (args.flags.message as string) ?? fail("feedback add needs -m <message>");
  const body: Record<string, unknown> = {
    author: "agent",
    body: message,
    lineStart: null,
    lineEnd: null,
  };
  if (args.flags.file) body.file = toRepoRelative(args.flags.file as string);
  if (args.flags.line) {
    if (!body.file) fail("feedback add --line needs --file");
    const [a, b] = (args.flags.line as string).split("-");
    const lineStart = Number(a);
    const lineEnd = Number(b ?? a);
    if (
      !Number.isInteger(lineStart) ||
      lineStart < 1 ||
      !Number.isInteger(lineEnd) ||
      lineEnd < lineStart
    )
      fail("feedback add --line expects <a-b> with integer line numbers a ≤ b (≥ 1)");
    body.lineStart = lineStart;
    body.lineEnd = lineEnd;
  }
  if (args.flags.quote) {
    if (body.lineStart == null) fail("feedback add --quote needs --line (a line-anchored note)");
    body.quote = args.flags.quote;
  }
  if (args.flags.side) {
    if (body.lineStart == null) fail("feedback add --side needs --line (a line-anchored note)");
    if (args.flags.side !== "old" && args.flags.side !== "new")
      fail("feedback add --side expects old|new");
    body.side = args.flags.side;
  }
  // Which stored round the anchor lives in (diff reviews). Omitted = the latest
  // round (the server defaults it); files reviews ignore it.
  if (args.flags.diff !== undefined) {
    const seq = Number(args.flags.diff);
    if (!Number.isInteger(seq) || seq < 1)
      fail("feedback add --diff expects a round number (seq ≥ 1)");
    body.patchSeq = seq;
  }
  const fb = await api("POST", `/api/reviews/${id}/feedback`, body);
  const loc = fb.file
    ? `${fb.file}${fb.line_start ? `:L${fb.line_start}${fb.line_end && fb.line_end !== fb.line_start ? `-${fb.line_end}` : ""}` : " (whole file)"}`
    : "(review-level)";
  console.log(`${fb.id}  ${loc}`);
}

// ---- stored diff rounds: r3 diff add | list | rm ----

async function cmdDiff(args: Args) {
  const sub = args.positional[0];
  const id = args.positional[1];
  if (sub === "add") {
    if (!id)
      fail(
        'diff add <review_id> [--label "<title>"] [--summary "<what changed overall>"]  (unified diff on stdin)',
      );
    const patch = await Bun.stdin.text();
    if (!patch.trim())
      fail("diff add expects a unified diff on stdin, e.g. `git diff | r3 diff add <id>`");
    const res = await api("POST", `/api/reviews/${id}/patches`, {
      patch,
      label: (args.flags.label as string) ?? null,
      summary: (args.flags.summary as string) ?? null,
    });
    console.log(`added diff ${res.seq} to ${id}`);
    return;
  }
  if (sub === "list") {
    if (!id) fail("diff list <review_id> [--json]");
    const patches = await api("GET", `/api/reviews/${id}/patches`);
    if (args.flags.json) {
      console.log(JSON.stringify(patches, null, 2));
      return;
    }
    if (!patches.length) {
      console.log("(no stored diffs — a legacy review still rendering live)");
      return;
    }
    for (const p of patches) {
      console.log(
        `${p.seq}  +${p.additions} −${p.deletions}  ${p.files.length} file${p.files.length === 1 ? "" : "s"}  ${p.label ?? ""}`,
      );
      if (p.summary) console.log(`     ▪ ${p.summary.replace(/\n/g, "\n       ")}`);
      for (const f of p.files) console.log(`     ${f}`);
    }
    return;
  }
  if (sub === "rm") {
    const seq = Number(args.positional[2] ?? fail("diff rm <review_id> <seq>"));
    if (!id || !Number.isInteger(seq)) fail("diff rm <review_id> <seq>");
    await api("DELETE", `/api/reviews/${id}/patches/${seq}`);
    console.log(`removed diff ${seq} from ${id}`);
    return;
  }
  fail("diff <add|list|rm> — manage a diff review's stored rounds");
}

// ---- files review membership: r3 files add | rm ----

async function cmdFiles(args: Args) {
  const sub = args.positional[0];
  const id = args.positional[1];
  const paths = args.positional.slice(2);
  if (sub !== "add" && sub !== "rm") fail("files <add|rm> <review_id> <path|glob>...");
  if (!id || !paths.length) fail(`files ${sub} <review_id> <path|glob>...`);
  // `add` expands globs against the git set (like create --files); `rm` matches
  // the review's stored paths literally (repo-relative).
  const body =
    sub === "add"
      ? { add: expandFileArgs(paths) }
      : { remove: paths.map((p) => toRepoRelative(p)) };
  const review = await api("POST", `/api/reviews/${id}/files`, body);
  const n = (review.source.files ?? []).length;
  console.log(`${id}: ${n} file${n === 1 ? "" : "s"} in review`);
}

// ---- files-review content snapshots: r3 snapshot [list|rm] ----

// Freeze a files review's current content so the human can diff turns. `list`/`rm`
// are subcommands; a bare id captures. The human's UI from/to picker diffs any two
// snapshots (or one vs. live) — the point is a multi-turn doc review that reads
// like a diff without leaving the live files view.
async function cmdSnapshot(args: Args) {
  const sub = args.positional[0];
  if (sub === "list") {
    const id = args.positional[1] ?? fail("snapshot list <review_id> [--json]");
    const snaps = await api("GET", `/api/reviews/${id}/snapshots`);
    if (args.flags.json) {
      console.log(JSON.stringify(snaps, null, 2));
      return;
    }
    if (!snaps.length) {
      console.log("(no snapshots — capture one with r3 snapshot <id>)");
      return;
    }
    for (const s of snaps) {
      const n = s.files.length;
      console.log(
        `${s.seq}  ${new Date(s.created_at).toLocaleString()}  ${n} file${n === 1 ? "" : "s"}  ${s.label ?? ""}`,
      );
    }
    return;
  }
  if (sub === "rm") {
    const id = args.positional[1] ?? fail("snapshot rm <review_id> <seq>");
    const seq = Number(args.positional[2] ?? fail("snapshot rm <review_id> <seq>"));
    if (!Number.isInteger(seq)) fail("snapshot rm <review_id> <seq>");
    await api("DELETE", `/api/reviews/${id}/snapshots/${seq}`);
    console.log(`removed snapshot ${seq} from ${id}`);
    return;
  }
  const id =
    sub ??
    fail(
      'snapshot <review_id> [--label "<name>"]  |  snapshot list <id>  |  snapshot rm <id> <seq>',
    );
  const res = await api("POST", `/api/reviews/${id}/snapshots`, {
    label: (args.flags.label as string) ?? null,
  });
  const n = res.files.length;
  console.log(`snapshot ${res.seq} of ${id} (${n} file${n === 1 ? "" : "s"})`);
}

async function cmdReanchor(args: Args) {
  const fid =
    args.positional[0] ?? fail("reanchor <feedback_id> --file <f> --line <a-b> [--quote <text>]");
  const lineSpec = (args.flags.line as string) ?? fail("reanchor needs --line <a-b>");
  const [a, b] = lineSpec.split("-");
  const lineStart = Number(a);
  const lineEnd = Number(b ?? a);
  if (
    !Number.isInteger(lineStart) ||
    lineStart < 1 ||
    !Number.isInteger(lineEnd) ||
    lineEnd < lineStart
  )
    fail("reanchor --line expects <a-b> with integer line numbers a ≤ b (≥ 1)");
  const res = await api("PATCH", `/api/feedback/${fid}/anchor`, {
    file: args.flags.file ? toRepoRelative(args.flags.file as string) : undefined,
    lineStart,
    lineEnd,
    quote: args.flags.quote ?? null,
  });
  console.log(
    `re-anchored ${fid} → ${res.file}:L${res.line_start}-${res.line_end} (${res.anchor})`,
  );
}

async function cmdStatus(id: string, status: "approved" | "abandoned", note?: string) {
  await api("PATCH", `/api/reviews/${id}`, note !== undefined ? { status, note } : { status });
  console.log(`${id} → ${status}${note ? ` (note: ${note.length} chars)` : ""}`);
}

// Approve a review — the happy terminal state (a watching agent's work is
// accepted). An optional "next steps for the agent" note (--note, or -m) rides
// along: the server stashes it and `r3 watch` prints it to the agent on the
// approval (which exits 0). `--note -` reads the note from stdin (long text).
async function cmdApprove(args: Args) {
  const id = args.positional[0] ?? fail('approve <id> [--note "<next steps for the agent>"]');
  const raw = args.flags.note ?? args.flags.message;
  let note: string | undefined;
  if (typeof raw === "string") {
    note = raw === "-" ? (await Bun.stdin.text()).trim() : raw.trim();
  }
  return cmdStatus(id, "approved", note);
}

// Edit a review's header fields — title and/or summary — in one PATCH (this maps
// 1:1 onto the unified endpoint). Only the flags you pass are touched, so
// `edit --title` leaves the summary alone. An empty value clears a field
// (`--title ""`); a summary of "-" is read from stdin, for long/multi-line text.
// No length cap — keep a summary short (~300 words).
async function cmdEdit(args: Args) {
  const id =
    args.positional[0] ??
    fail(
      'edit <id> [--title "<t>"] [--summary "<s>"]   ("" clears a field; --summary - reads stdin)',
    );
  const body: { title?: string | null; summary?: string | null } = {};
  if ("title" in args.flags) {
    const t = typeof args.flags.title === "string" ? args.flags.title.trim() : "";
    body.title = t || null;
  }
  if ("summary" in args.flags) {
    const raw = typeof args.flags.summary === "string" ? args.flags.summary : "";
    if (raw === "-") {
      const piped = (await Bun.stdin.text()).trim();
      if (!piped) fail("edit --summary - expects the summary text on stdin");
      body.summary = piped;
    } else {
      body.summary = raw.trim() || null;
    }
  }
  if (!("title" in body) && !("summary" in body))
    fail('edit needs --title and/or --summary, e.g. r3 edit <id> --title "New name"');
  const r = await api("PATCH", `/api/reviews/${id}`, body);
  const parts: string[] = [];
  if ("title" in body) parts.push(r.title ? `title "${r.title}"` : "title cleared");
  if ("summary" in body)
    parts.push(r.summary ? `summary (${r.summary.length} chars)` : "summary cleared");
  console.log(`${id}: ${parts.join(", ")}`);
}

// ---- projects registry ----

async function cmdRepo(args: Args) {
  const sub = args.positional[0];
  if (sub === "list") {
    const repos = await api("GET", "/api/repos");
    if (!repos.length) {
      console.log("(no registered repos)");
      return;
    }
    for (const r of repos) {
      const flag = r.present ? "" : "  ⚠ path missing — relink or forget";
      console.log(`${r.id}  ${r.name ?? ""}${flag}`);
      console.log(`  ${r.commonDir}`);
    }
    return;
  }
  if (sub === "relink") {
    const id = args.positional[1] ?? fail("repo relink <repo-id> <path>");
    const path = args.positional[2] ?? fail("repo relink <repo-id> <path>");
    const r = await api("POST", `/api/repos/${id}/relink`, { path: resolve(process.cwd(), path) });
    console.log(`relinked ${r.id} → ${r.commonDir}`);
    return;
  }
  fail("repo <list|relink>");
}

async function cmdForget(args: Args) {
  const id = args.positional[0] ?? fail("forget <repo-id>");
  await api("DELETE", `/api/repos/${id}`);
  console.log(`forgot ${id} (and its reviews)`);
}

// ---- daemon lifecycle ----

// Run the daemon in-process (the hidden `__daemon` re-exec target). Imported
// dynamically so the normal CLI path never loads the server + its deps.
async function runDaemon(): Promise<void> {
  const { startDaemon } = await import("../server/index.ts");
  await startDaemon();
}

async function cmdDaemonStatus(): Promise<void> {
  const info = readDaemonJson();
  if (!info) {
    console.log("r3: no daemon (no daemon.json)");
    return;
  }
  const h = await probe(info.url);
  if (!h) {
    console.log(
      `r3: daemon.json present (pid ${info.pid}, ${info.url}) but not responding — stale`,
    );
    return;
  }
  const skew = h.version !== R3_VERSION ? `  ⚠ CLI v${R3_VERSION} — restart to upgrade` : "";
  console.log(`r3 daemon: ${info.url}  pid ${info.pid}  v${h.version}${skew}`);
}

async function cmdDaemonStart(): Promise<void> {
  const info = readDaemonJson();
  if (info && (await probe(info.url))) {
    console.log(`r3 daemon already running: ${info.url} (pid ${info.pid})`);
    return;
  }
  const started = await spawnDaemon();
  console.log(`r3 daemon started: ${started.url} (pid ${started.pid})`);
}

async function cmdDaemonStop(): Promise<void> {
  const info = readDaemonJson();
  if (!info) {
    console.log("r3: no daemon running");
    return;
  }
  // Confirm the pid in daemon.json is actually our live daemon before signalling
  // it — a crash that skipped cleanup leaves a stale daemon.json, and the OS may
  // have recycled that pid to an unrelated process. A health probe is proof.
  if (!(await probe(info.url))) {
    if (readDaemonJson()?.pid === info.pid) removeDaemonJson();
    console.log("r3: no live daemon (cleared stale daemon.json)");
    return;
  }
  try {
    process.kill(info.pid, "SIGTERM");
  } catch {
    // already gone
  }
  for (let i = 0; i < 60; i++) {
    if (!(await probe(info.url))) break;
    await sleep(50);
  }
  // Clear daemon.json only if it's still the one we stopped (don't clobber a successor).
  if (readDaemonJson()?.pid === info.pid) removeDaemonJson();
  console.log(`r3 daemon stopped (pid ${info.pid})`);
}

async function cmdDaemonRestart(): Promise<void> {
  await cmdDaemonStop();
  await sleep(150);
  await cmdDaemonStart();
}

const HELP = `r3 — local human<->agent review CLI

  create --commit <sha>                         [--title T] [--summary S] [--meta k=v]...
  create --diff <base>..<head>                  [--title T] [--summary S] [--meta k=v]...
  create --working | --staged                   [--title T] [--summary S] [--meta k=v]...
  create [--ref <ref>] [--title T] [--summary S] [--meta k=v]... --files <glob|path>...
                                                 # --files is GREEDY: it swallows every
                                                 #   remaining token as a path/glob, so ALL
                                                 #   other flags (--title/--summary/--meta/
                                                 #   --ref) MUST come BEFORE it.
                                                 #     WRONG: create --files '**/*.ts' --meta s=1 --title X
                                                 #            (--meta, s=1, --title, X read as filenames)
                                                 #     RIGHT: create --meta s=1 --title X --files '**/*.ts'
                                                 #   Globs (e.g. 'server/**/*.ts') match the
                                                 #   git set (respects .gitignore); plain
                                                 #   paths are taken literally.
  create --scratch                              [--title T] [--summary S] [--meta k=v]...
                                                 # adhoc review with no git source: makes an
                                                 #   empty review + a scratch directory and
                                                 #   prints its path (3rd line). Drop files in
                                                 #   that dir; the daemon watches it and they
                                                 #   load into the review live (edit to update).
                                                 #   TOP-LEVEL FILES ONLY — keep files flat in
                                                 #   the dir; subdirectories and their contents
                                                 #   are NOT shown or watched (the UI warns if any
                                                 #   subdirectory is present).
  create --stdin-diff                           [--label L] [--title T] [--summary S] [--meta k=v]...
                                                 # review a unified diff piped on stdin, e.g.
                                                 #   git diff main..HEAD | r3 create --stdin-diff
  list   [--meta k=v]... [--status open]         # filter by meta, e.g. --meta session=<id>
  show   <id> [--json]                           # full history: every item, thread, and round
  prompt <id> [--all] [--feedback <fid,...>]     # print feedback you haven't seen yet (new
                                                 #   items, human follow-ups, resolutions) and
                                                 #   mark it delivered, so the next call won't
                                                 #   repeat it.
                                                 #   --all: re-print all open items, mark
                                                 #     nothing (r3 show = full history)
                                                 #   --feedback: limit to a subset of ids
  watch  <id> [--session <name>] [--agent-id <id>]
              [--auto-fetch-timeout <sec>] [--timeout <sec>]
                                                 # block until the human hits Submit,
                                                 #   then print the prompt (no copy-paste).
                                                 #   Exit codes: 10 = feedback submitted
                                                 #   (act on it, watch again); 0 = review
                                                 #   approved (done — any next-steps note is
                                                 #   printed); 3 = abandoned; 2 = timed out.
                                                 #   --session: display name shown in the UI
                                                 #   --agent-id: machine handle for other tools
                                                 #   --timeout: give-up deadline in seconds (default 0 = never)
                                                 # --auto-fetch-timeout <sec>: opt-in — instead of
                                                 #   waiting for Submit, auto-send pending feedback
                                                 #   after N idle seconds. Use it on long reviews so
                                                 #   the agent starts fixing sooner without a manual
                                                 #   Submit; the UI shows a "streaming to agent"
                                                 #   indicator while it's on. 0 = off (wait for Submit).
  diff add <id> [--label L] [--summary S]        # append a diff round from stdin, e.g.
                                                 #   git diff | r3 diff add <id> --label "round 2" \
                                                 #     --summary "what changed overall this round"
                                                 #   --label is a short title; --summary is prose
                                                 #   describing the round (shown per-round in the UI).
                                                 #   Rounds are immutable + independent — new
                                                 #   work goes in a new round, never edits an
                                                 #   old one (line numbers needn't agree).
  diff list <id> [--json]                        # the review's rounds (+stats, files)
  diff rm <id> <seq>                             # drop a wrong round whole (re-add corrected)

  files add <id> <path|glob>...                  # grow a files review (globs match the git set)
  files rm  <id> <path>...                       # shrink it

  snapshot <id> [--label L]                      # freeze a files review's current content as a
                                                 #   snapshot. The UI's from/to picker diffs any two
                                                 #   snapshots (or one vs. live), so the human sees
                                                 #   exactly what changed between turns. Take one
                                                 #   before you start editing and again after.
  snapshot list <id> [--json]                    # the review's snapshots (+ file counts)
  snapshot rm <id> <seq>                         # drop a snapshot (feedback never orphans)

  reply  <feedback_id> -m "<msg>"
              [--diff <seq> --file <f> --line <a-b> [--quote "<text>"]]
                                                 # optional pin: where in round <seq> your
                                                 #   change landed ("addressed in diff N").
                                                 # <msg> renders Markdown; reference code with
                                                 #   @<path>:L<a-b> (a click-to-scroll link,
                                                 #   pinned to the round/snapshot at post time)
  feedback add <id> -m "<msg>"
              [--file <f> [--line <a-b>] [--quote "<text>"] [--side old|new]] [--diff <seq>]
                                                 # open a feedback item yourself — guide the
                                                 #   human to what matters, ask, flag a risk.
                                                 #   Same entity as their notes: they reply /
                                                 #   resolve it and you see that via watch/prompt.
                                                 #   No --file = a review-level note; --file
                                                 #   alone = whole-file; +--line = anchored (the
                                                 #   quote is derived from the round/live content
                                                 #   unless --quote pins it). --diff names the
                                                 #   round (default: latest); --side default new.
  reanchor <feedback_id> --file <f> --line <a-b> [--quote "<text>"]
                                                 # files reviews only — a diff review's rounds
                                                 #   are immutable; pin a reply instead
  edit   <id> [--title "<t>"] [--summary "<s>"]  # set a review's title/summary. An empty value
                                                 #   ("" ) clears that field; --summary - reads the
                                                 #   summary from stdin (long/multi-line). Only the
                                                 #   flags you pass are touched. The summary renders
                                                 #   as Markdown in the UI and supports @<path>:L<a-b>
                                                 #   refs (resolved against current content — not
                                                 #   version-pinned like reply refs).
  approve <id> [--note "<next steps>"]           # accept the work (--note/-m: optional next
                                                 #   steps for the agent, printed by r3 watch;
                                                 #   --note - reads it from stdin)
  abandon <id>                                   # close a review out without approving

  repo list                                      # registered projects + live status
  repo relink <repo-id> <path>                   # reattach a moved repo
  forget <repo-id>                               # drop a project and its reviews
  start | stop | status | restart                # per-user daemon lifecycle
  guide                                          # how r3 works (the agent orientation),
                                                 #   then this full reference. start here.
`;

// The agent orientation: what r3 is, the review loop, and the commands in flow
// order. `r3 guide` is the text an AGENTS.md in another repo can defer to instead
// of duplicating (and drifting from) these instructions. Static — needs no
// daemon and no repo, like help.
const GUIDE = `r3 — agent guide

r3 is a local-first review tool for human <-> agent collaboration. You (the agent)
put work up as a *review*; the human reads it in the browser and leaves *feedback*
(anchored to a line/quote, a whole file, or a summary); you reply to each item by id
and the decision shows up live. One per-user daemon serves every repo and spawns
lazily on your first command — run commands from inside the repo under review.

## The loop

1. r3 create ...  — prints an id + URL; surface the URL to the human.
   Before they start reading, orient them: set a summary (r3 edit <id>
   --summary "...") and open feedback on the spots that matter
   (r3 feedback add — see "Guide the review" below). A guided review reads
   faster than a wall of 30 files.
2. r3 watch <id>  — blocks until the human clicks Submit, then prints the new
   feedback and the exact reply commands. Exit codes: 10 = feedback to act on,
   0 = approved (done; prints any "next steps" note), 3 = abandoned, 2 = timed out.
3. Work each item, then: r3 reply <feedback_id> -m "what you did / why not".
   Reply by the stable feedback id, never a positional index; replies are plain
   messages (the human resolves/reopens items in the UI — you'll see
   "[resolved]" in a later prompt when they do).
4. Watch again for the next round.

Watch by default: after creating a review, and after each round of replies, run
r3 watch <id> unless the human told you not to — that's how you receive feedback
and learn when they approve. Each call is one round: it exits 10 when there's
feedback (act on it, then run r3 watch <id> again) and 0 when the human approves
(you're done). Just re-run the command each round — no shell loop needed.

r3 watch never times out by default (it blocks until the human acts). Unless the
user asks you to set a timeout, run it with no timeout — and if your tool harness
caps how long a command can run, run it in the background rather than cutting the
wait short.

Some items target a whole file or a summary (no line span) — reply the same way.

## Guide the review (agent-authored feedback)

Feedback flows both ways: you can open items too, with the same anchors and
threads as the human's notes. Use it to steer a big review — point at the files
that matter, ask a question, flag a risk you're unsure about:
  r3 feedback add <id> -m "..."  # review-level note
  r3 feedback add <id> -m "..." --file src/db.ts  # about one file
  r3 feedback add <id> -m "..." --file src/db.ts --line 40-52  # anchored to lines
Your items appear live in their UI; the human replies or resolves them, and
those answers reach you through the same watch/prompt loop (a bare resolve
arrives as "[resolved] — no action needed"). Your own feedback never echoes
back to you. Pair it with a review summary (r3 edit --summary) for orientation:
the summary is the map, feedback items are the pins. The summary renders as
Markdown in their UI and supports the same @<path>:L<a>[-b] code refs as
replies — but a summary ref resolves against the review's CURRENT content
(the summary is edited in place; nothing is version-pinned), so keep it
pointing at things that hold across rounds.

## Two kinds of review

files — a live view of current content: watched, edits appear immediately, feedback
re-anchors as files change.
  r3 files add|rm <id> <path|glob>...  # change the file set
  r3 snapshot <id> --label "..."  # freeze content so the human can diff your changes across turns
  r3 snapshot list|rm <id> [seq]
  r3 reanchor <feedback_id> --file <f> --line <a-b> [--quote "..."]  # when an edit moved the code

diff — immutable rounds: the diff is snapshotted once (git is never consulted
again). Append fixes as a new round; rounds never change, so feedback can't orphan.
  git diff ... | r3 diff add <id> --label "round 2" --summary "<what changed>"
  r3 reply <feedback_id> -m "..." --diff <seq> --file <f> --line <a-b>  # pin the reply to the fix
  r3 diff list|rm <id> [seq]  # reanchor is files-only

## Referencing code in replies

Point the human at exact code in a reply with @<path>:L<start>[-end], e.g.
@server/db.ts:L13 or @web/src/api.ts:L11-20 — a clickable link that scrolls their
pane to that spot, instead of pasting bare line numbers into prose. Reply bodies
also render Markdown (\`code\`, **bold**, lists, fenced blocks). These inline @refs
complement the --diff pin above (the one structured "here's where the fix landed"
marker); this syntax is yours — humans quote code via the UI.

A ref is pinned to the review's version when you post, so it keeps pointing at the
code as written. Diff review: the latest round (always present). Files review: the
latest snapshot — snapshot first for a stable ref, else the ref tracks live content
and can drift as you edit. Order the work to choose old-vs-new:
  - snapshot / add a round, THEN reply -> refs point at the new code
  - reply, THEN change the code        -> refs point at the old code
  - to cite both, split into two replies (one before the change, one after)

## Create a review

Every form prints id + URL; tag with --meta session=<your-session>.
  r3 create --working  # working-tree diff (untracked included)
  r3 create --staged  # index diff
  r3 create --commit <sha>  # one commit
  r3 create --diff <base>..<head>  # branch / range
  git diff ... | r3 create --stdin-diff  # any piped diff
  r3 create [--title T] [--meta k=v]... --files 'src/**/*.py' '*.md'  # live file set
       # --files is GREEDY: it swallows every following token as a path/glob, so all
       # other flags (--title/--meta/--ref/--summary) MUST come BEFORE it.
       #   WRONG: r3 create --files 'src/**/*.py' --meta session=abc --title X
       #          (--meta, session=abc, --title, X are all read as filenames -> fails)
       #   RIGHT: r3 create --meta session=abc --title X --files 'src/**/*.py'
  r3 create --scratch  # no git source; prints a dir path on line 3; drop files there (flat dir), appear live

## Other commands

  r3 show <id> [--json]  # full history: every item, thread, round
  r3 prompt <id> [--all]  # unseen feedback only, marks it delivered; --all reprints all open
  r3 list --meta session=<id>  # your reviews
  r3 edit <id> --title "..." | --summary "..."  # rename / add overview (--summary - reads stdin)
  r3 approve <id> [--note "..."]  # ends the loop (r3 watch exits 0)
  r3 abandon <id>  # close without approving
  r3 restart  # if the daemon drifts; not mid-loop (drops in-flight watches)

Run r3 -h for the full flag reference.
`;

// Commands that talk to the daemon (everything but lifecycle + help). They need
// SERVER resolved (discovering/spawning the daemon) before running.
const SERVER_COMMANDS = new Set([
  "create",
  "list",
  "show",
  "prompt",
  "watch",
  "reply",
  "feedback",
  "reanchor",
  "approve",
  "resolve",
  "abandon",
  "edit",
  "diff",
  "files",
  "snapshot",
  "repo",
  "forget",
]);

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  // Hidden re-exec target: become the daemon (used by lazy-spawn / `r3 start`).
  if (cmd === "__daemon") return runDaemon();

  // Lifecycle commands manage the daemon directly — no auto-spawn.
  switch (cmd) {
    case "start":
      return cmdDaemonStart();
    case "stop":
      return cmdDaemonStop();
    case "status":
      return cmdDaemonStatus();
    case "restart":
      return cmdDaemonRestart();
    case "guide":
      // The single orientation command: the how-to prose + common commands. The
      // exhaustive flag reference lives in HELP (`r3 -h`), which the guide points to.
      console.log(GUIDE);
      return;
    case undefined:
    case "-h":
    case "--help":
      console.log(HELP);
      return;
  }

  const args = parseArgs(rest);
  if (SERVER_COMMANDS.has(cmd)) SERVER = await ensureServer();

  switch (cmd) {
    case "create":
      return cmdCreate(args);
    case "list":
      return cmdList(args);
    case "show":
      return cmdShow(args);
    case "prompt":
      return cmdPrompt(args);
    case "watch":
      return cmdWatch(args);
    case "reply":
      return cmdReply(args);
    case "feedback":
      return cmdFeedback(args);
    case "reanchor":
      return cmdReanchor(args);
    case "diff":
      return cmdDiff(args);
    case "files":
      return cmdFiles(args);
    case "snapshot":
      return cmdSnapshot(args);
    case "approve":
    case "resolve": // deprecated alias for `approve` (status was once "resolved")
      return cmdApprove(args);
    case "abandon":
      return cmdStatus(args.positional[0] ?? fail("abandon <id>"), "abandoned");
    case "edit":
      return cmdEdit(args);
    case "repo":
      return cmdRepo(args);
    case "forget":
      return cmdForget(args);
    default:
      fail(
        `unknown command "${cmd}"\n\n${HELP}\n\nNew to r3? Run 'r3 guide' for how it works and the review loop.`,
      );
  }
}

main();
