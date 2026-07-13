# r3 — Review. Revise. Resolve.

A **local-first review tool for AI-generated code and docs**. A long-running
per-user daemon on localhost owns review + feedback state for all your repos;
reviews are created from the CLI/agent, and you review the commits, diffs, and raw
files they capture in the browser and leave line/quote-anchored **feedback**; an AI
agent (or you) **replies** by id and the decision shows up **live** over SSE. The
daemon, CLI, and SPA ship as one self-contained binary.

For usage see [`README.md`](README.md). This file is the orientation map for
working _in_ the repo **and the single source of truth for its design** — when a
design decision changes, update the relevant section here.

**Why r3 / prior art.** When an AI agent writes code or docs you want to read the
result, mark the exact spots you care about, hand those notes back, and watch the
agent react in place — without copy-pasting transcripts. The MIT-licensed **difit**
and **diffx** informed the design; r3's delta from both: a **persisted review +
feedback/reply model**, **raw-file** (not just diff) reviews, headless CLI creation
with queryable session/meta, an **agent re-anchor API** to keep feedback from
orphaning, and a structured **reply/watch protocol** that round-trips live into
the UI.

## Architecture

The server is **authoritative**; there are **three clients of one HTTP/JSON API**
— the browser (SPA), the CLI, and the agent (through the CLI). Because the CLI and
agent are first-class, **the HTTP/JSON contract in `shared/types.ts` is the
product**, not an implementation detail of the React client.

```
          ┌── browser (SPA)  ─ fetch + SSE ──┐
agent ── CLI (thin HTTP client) ─ HTTP ───────┼──►  daemon (Hono + bun:sqlite)
          └── you at the terminal ────────────┘        one per user, one port,
                                                        one global store
```

- **One per-user daemon** spans every repo, on a stable port (default 8791),
  behind one origin. It's spawned **lazily** on the first CLI call (or by opening
  the browser) à la the tmux server — nothing to start by hand — and announces
  itself in `$XDG_RUNTIME_DIR/r3/daemon.json` so the CLI finds it with zero config.
- **The CLI is the single entry point and the binary.** `cli/index.ts` is a thin
  HTTP client — every command is one HTTP call; it never writes sqlite directly
  (single writer, the server stays authoritative). A hidden `__daemon` subcommand
  re-execs the same script/binary to _serve_; `ensureServer()`
  discovers-or-lazily-spawns the daemon.
- **Reviews live in one global sqlite** (`$XDG_STATE_HOME/r3/r3.sqlite`) keyed by a
  **projects registry**, not per-repo files. A project's identity is its **shared
  git object store** (`realpath(git rev-parse --git-common-dir)`), so all worktrees
  of one clone are one project and a `cp -r` copy is a distinct empty one.
- **The server core is de-globalized** into a per-request `Repo` context
  (`server/repo.ts`): `{ repoId, commonDir, worktreePath, descriptor, stale, git(),
gitText(), safePath() }`. `git()` runs with `cwd = worktreePath`; `safePath()`
  validates against it. The global sqlite is the only process-wide singleton;
  everything else is per-Repo.
- **The daemon is repo-agnostic** — it holds no ambient "default repo". Each
  request resolves its `Repo` fresh, most-specific first: a `?review=<id>` (the row
  carries its repo), the CLI's `x-r3-repo` header (computed per call from the CLI's
  own checkout), or the browser's `?repo=<id>` selector. A request that names none
  gets `null` → `400 "no repo context"`; the CLI refuses a repo-scoped command
  (e.g. `r3 create`) run outside a git repo rather than letting it reach the daemon.
- **Freshness + live updates** flow one way to the clients: a file watcher
  (`server/watcher.ts`) watches only the files open reviews reference and pushes
  `file-changed`; every review/feedback/reply write bumps `review.updated_at` and
  broadcasts over SSE (`server/sse.ts`). The SPA invalidates its TanStack Query
  cache on the matching event.

A **worktree** shares its clone's common-dir, so it's the _same_ project — but it
has its own working tree, index, and HEAD, so a review records a `worktree`
descriptor `{ name, branch, pathHint }` and runs its git ops in the exact worktree
it was created in. Resolution matches `worktree.name` (then branch) against live
`git worktree list`, so `git worktree move` auto-resolves; a removed worktree falls
back to the primary for immutable reviews and flags live ones `stale`. A moved
_repo_ is a one-row `UPDATE repos SET common_dir=…` (`r3 repo relink`) — reviews
reference the immutable `repo_id`, never a path. A `cp -r` copy has a new
common-dir ⇒ a distinct empty project (identity lives only in the store, so there
is no `.r3/id` marker to confuse a move with a copy).

## Module layout

Start at `shared/types.ts` — **the HTTP contract** all three clients agree on —
then `server/index.ts` (daemon entry, routes, guards), `server/repo.ts` (the Repo
context), and `cli/index.ts` (the binary and the agent's entry point).

```
server/          Hono daemon + bun:sqlite global store
  index.ts       startDaemon(): HTTP/JSON API + SPA serving + host/token guards
  config.ts      XDG discovery: daemon.json, token, start-lock, bind/allowlist, URLs
  repo.ts        per-request Repo context: identity, registry, worktree resolution
  db.ts          global store + repos registry + reviews/feedback/replies CRUD
  git.ts         git ops (log/tree/diff/status) + unified-diff parser + content reads
  reviews.ts     domain logic: create/list/detail, re-anchoring, rounds, membership
  patches.ts     stored diff rounds: parse/validate/render + reply-pin checks
  snapshots.ts   files-review content snapshots: capture + derived-diff render
  textdiff.ts    in-process line differ (Myers/LCS) -> DiffFileChange, no git
  anchor.ts      quote relocation — keep feedback from orphaning
  dirty.ts       lazy re-anchor gate: only re-anchor a review whose files changed
  highlight.ts   Shiki (code) + markdown-it (.md), content-sha cached
  render.ts      raw-file render for kind:'files' (renderFile + renderContent)
  prompt.ts      the agent-prompt text (same as the UI's "Copy agent prompt")
  sse.ts         pub/sub broadcast    watcher.ts   review-scoped file watching -> SSE
  watchers.ts    live `watch` presence registry (who's blocked on a review)
  scratch.ts     adhoc scratch-review storage (ref:'SCRATCH') outside any repo
  paths.ts       pure safePathIn(root, p) path guard    ids.ts  id minting
cli/index.ts     thin HTTP client + daemon lifecycle — the agent's entry, the binary
web/             React 19 + TanStack Query + Tailwind v4 SPA (bundled by Bun)
  src/pages/     Home.tsx (the reviews list — the `/` landing view), ReviewView.tsx (the review)
  src/components/ DiffView, FileView, FileCard, FileBrowser, FeedbackPanel,
                 ReviewSwitcher (navbar "Reviews" breadcrumb), SettingsPopup,
                 ReviewSummary, SnapshotSelect, Logo, Message (MessageProse +
                 the shared QuoteBubble/useQuoteBubble selection-to-quote)
                 (each with a *.stories.tsx)
  src/api.ts     typed fetch wrappers    hooks.ts  SSE + query wiring
  src/markdown.ts client Markdown render (markdown-it, html:false) + @path:Lx-y refs
  src/viewed.ts  server-backed per-round/per-sha "viewed" fold-state
  src/drafts.ts  per-review composer drafts (localStorage)   selection.ts  range select
  router.ts      tiny pathname router (`/` reviews list, `/review_<id>` a review)   ui.tsx  shared UI
shared/types.ts  the HTTP contract (domain model + request/response shapes)
shared/version.ts build version — /api/health reports it; the CLI warns on skew
scripts/compile.ts  one `Bun.build({compile})` — bundles+embeds the SPA -> ./r3 binary
scripts/spa-css.ts  browser-target Tailwind CSS pre-pass for compile builds (de-nests)
scripts/release-binaries.ts  cross-compile dist/r3-<os>-<arch> + SHA256SUMS for a release
scripts/stage-npm-packages.ts  stage the 4 per-platform npm binary packages + stamp launcher pins
bunfig.toml      registers bun-plugin-tailwind so the from-source daemon bundles CSS
npm/             the published `r3` launcher (bunx/npx): resolves+execs the matching
                 per-platform binary package (`@hyperlogue/r3-<os>-<arch>`, an optional dep)
```

## Domain model

Three persistent entities — **Review**, **Feedback**, **Reply** — plus **Patch**,
a diff review's stored rounds (full shapes in `shared/types.ts`, SQL schema in
`server/db.ts`). Feedback and Reply stay **separate**: feedback has a
lifecycle/**status** + an anchor; a reply is a **pure message** in the thread with
no status of its own (merging them would make illegal states — a "reply" that's
"resolved" — representable). Resolving is a **status toggle on the feedback**
(`PATCH /api/feedback/:id`), never a property of a reply.

- **Review** — `id`, `repo_id`, `worktree`, `title` (editable via `r3 edit` or the
  UI), `summary` (a short free-form overview — the agent's *guide* to the review;
  editable via `r3 edit` only — CLI-only, read-only in the UI, rendered as
  Markdown with `@path:Lx-y` refs), `kind` (`'diff'|'files'` — the render mode),
  `source` (files: what to fetch; diff: provenance only), `meta` (free-form,
  **queryable** — e.g. `{ session, agent, branch }`), `status`
  (`open|approved|abandoned`).
- **Patch** — one immutable stored diff round of a `kind:'diff'` review:
  `review_id`, `seq` (monotonic, never reused), `label`, `summary` (prose overview
  of what the round changed, shown per-round in the UI), `body` (raw unified diff).
  Appended via `r3 diff add` (`--label`/`--summary`), removed whole via `r3 diff
rm` — never edited, no hunk-level surgery. Cascade-deleted with the review.
- **Feedback** — an anchored note, authored by **either side**: `author`
  (`human|agent`) is a first-class axis — the human annotates in the UI, the
  agent via `r3 feedback add` (guide the reading order, ask, flag a risk), and
  both get the same anchors, threads, and lifecycle. Agent-authored feedback is
  **born delivered** (`sent_at` = creation), so it never echoes back in the
  agent's own prompts — only the human's replies/resolution flow back. Fields:
  `file`, `side` (`old|new|null`), `line_start/end`,
  `quote` (**the anchor of record** — the line number is only a hint; for a
  line-anchored `r3 feedback add` without `--quote` the server derives it from
  the round/live content, rejecting an unreadable range rather than storing a
  driftable quote-less anchor), `code_sha`
  (recorded at anchor time; staleness surfaced via `anchor`), `anchor`
  (`anchored|outdated`), `patch_seq` (which round, for diff reviews; a
  line-anchored note naming no round lands in the latest), `status`
  (**`open|resolved`** — two states, human-driven; open = needs attention,
  resolved = done, and the _why_ — fixed, answered, dismissed — lives in the
  thread, not the enum). The agent references feedback by its
  **stable `id`** (`feedback_<short>`), never a positional index. Two span-less
  variants exist, and neither is ever re-anchored: a **summary** note (`file` is
  the `SUMMARY_FILE` sentinel `@summary`; `patch_seq` names a round's summary,
  null = the review summary; shown as "review summary" / "diff N summary") and a
  **whole-file** note (a real `file` path with `line_start`/`line_end`/`quote` all
  null; shown as "`<path>` (whole file)").
- **Reply** — `feedback_id`, `author`, `body`, plus an optional **pin**
  (`patch_seq`, `file`, `line_start/end`, `quote`)
  saying where in a later round the change addressing the feedback landed
  (`r3 reply <fid> -m … --diff <seq> --file <f> --line <a-b>`). A reply is always
  a plain message — the human drives status (resolve/reopen) from the UI; an
  `action` key from a stale client is ignored. One
  feedback can accumulate several pinned replies across rounds — the fix's history.
  A reply also carries `ref_version`, captured at post time: the latest round
  (diff) / snapshot (files), or null. It's the version the reply's inline
  `@path:Lx-y` **code refs** resolve against, so a ref stays pointing at the code
  as it was written (immutable) — the agent orders snapshot/round vs. reply to pin
  old-vs-new, and splits a reply in two to cite both.

**Message rendering.** Feedback bodies and replies are stored as **plain text** (the
contract carries raw text — edited inline, created optimistically), and rendered
**client-side** as safe Markdown (`web/src/markdown.ts`, markdown-it `html:false`).
An agent-authored `@path:Lx-y` token becomes a **click-to-scroll** ref: it jumps the
pane to that file/line, resolved against the message's version (a reply's
`ref_version`, or a feedback body's own round). Humans don't type refs — selecting
code while composing (or text in an agent reply) offers a **"Quote"** button that
drops it in as a `>` blockquote instead. **The review summary renders the same
way** (`ReviewSummary`) — markdown + refs — but a summary is edited in place, so
its refs pin no version and resolve against the **live/current view**. Selecting
summary text offers "Quote in note" (a general-feedback blockquote), replacing
the old select-to-anchor there: rendered markdown has no stable source offsets to
anchor a quote to. Round summaries in the diff pane keep their plain-text anchor
flow, and legacy `@summary`-anchored feedback still renders.

## Review kinds & sources

`kind` is the render mode; the two kinds have opposite temporal philosophies:
**`files` = a live view of now** (watched, re-anchored, membership editable);
**`diff` = an immutable history of stored rounds** (append-only patches owned by the
daemon — where a diff came from stops mattering once snapshotted; git is consulted
once, at capture time, never at render).

| What                               | `kind` / `source`                                                 |
| ---------------------------------- | ----------------------------------------------------------------- |
| single commit                      | `diff` · `{ base:'<sha>^', head:'<sha>' }` (CLI `--commit` sugar) |
| branch / range                     | `diff` · `{ base:'main', head:'feature' }`                        |
| working tree / index snapshot      | `diff` · `{ base:'HEAD', head:'WORKING' }` or `'STAGED'`          |
| piped diff (`--stdin-diff`)        | `diff` · `{ base:'', head:'' }`                                   |
| raw files (no diff)                | `files` · `{ ref:'WORKING', files:[…] }`                          |
| adhoc scratch review (`--scratch`) | `files` · `{ ref:'SCRATCH', files:[] }` (derived from the dir)    |

- **Diff reviews store rounds, not refs.** Every create flag is sugar over one
  primitive — snapshot a unified diff as round 1 into the `patches` table
  (`--working` also synthesizes adds for untracked files). Follow-up work is
  appended as round 2, 3, … (`git diff … | r3 diff add <id>`); rounds are
  immutable and independent (line numbers needn't agree across rounds), the round
  is the unit, and `source` is provenance only. No watching, no re-anchoring, no
  staleness — the Gerrit-patchset shape, minus everything Gerrit needs for
  server-side merging. (`server/patches.ts`)
- A **files review** can also carry **content snapshots** — frozen full-text
  captures of every file, taken on demand (`r3 snapshot <id>`). Unlike a diff
  round (unified-diff text), a snapshot holds whole files, so the daemon can
  **derive an accurate diff between any two** (or a snapshot and live content)
  itself, with no git — which is what lets it work for scratch reviews outside any
  repo. The UI's from/to picker makes a multi-turn doc review read like a diff
  without leaving the live view; feedback stays anchored to the live file, never
  scoped to a snapshot. Snapshots are append-only + immutable; removing one orphans
  nothing.
- Sentinels (files reviews): `WORKING` (working tree), `SCRATCH` (adhoc content
  in the daemon's scratch dir), else any git ref/sha. `WORKING`/`SCRATCH` track
  live content ⇒ re-read + re-anchored on change; a pinned sha/ref is
  **immutable** ⇒ stable anchors. `repo.isImmutableSource(source)` is the
  predicate; it also drives worktree fallback.
- **Scratch reviews**: `r3 create --scratch` makes an empty `files`/`SCRATCH`
  review + a per-review directory (path printed); the agent drops files there and
  the daemon watches the dir (flat, top-level only). The scratch dir is the
  _second_ allowed `safePath` root (besides the worktree). (`server/scratch.ts`)
- `--files` takes paths **and** globs over the repo's git set (tracked + untracked,
  minus `.gitignore`d), so `**/*.ts` never pulls in `node_modules/`. It's
  **greedy** — put it last. Membership is editable later: `r3 files add|rm <id> …`.

## The review loop (the agent interface)

The human reviews in the browser, then hands feedback to the agent. `r3 guide`
prints this whole flow as agent-facing orientation text (the `GUIDE` constant in
`cli/index.ts`) — external repos defer to it, so it must stay truthful (see
House rules). Two paths:

- **Copy prompt** (manual) — the human clicks "Copy agent prompt" and pastes it.
- **Watch + Submit** (hands-off) — the agent runs **`r3 watch <id>`**, which
  registers as a live watcher (`server/watchers.ts`) and **blocks**. The feedback
  panel **adapts**: with a watcher it shows "Submit to agent" + a "● `<session>`
  watching" indicator instead of "Copy prompt". The human leaves feedback and
  clicks **Submit**; the server broadcasts `submitted`, `watch` prints the prompt
  (review id + feedback ids + the exact reply/reanchor commands) and exits.

The agent then works each item and **replies by feedback id** — always a plain
reply saying what it changed / why it disagrees / a follow-up (`r3 reply <fid> -m
"…"`); the human drives status from the UI. The follow-up move differs by kind:

- **diff review** — append the fixes as a new round, then pin each reply to where
  the change landed: `git diff … | r3 diff add <id> --label "round 2"`, then
  `r3 reply <fid> -m "…" --diff <seq> --file <f> --line <a-b>`. The UI shows
  "↳ addressed in diff N" with a jump.
- **files review** — if an edit moves the code a feedback points at, **re-anchor**
  (`r3 reanchor <fid> --file <f> --line <a-b> --quote "<new text>"`).

**Feedback flows both ways.** The agent can open items too (`r3 feedback add
<id> -m … [--file <f> [--line <a-b>]]`) — guide the human through a big review
(point at the 3 files that matter out of 30), ask a question, flag a risk. They
appear live in the UI wearing an "agent" chip, rank into the human's attention
zone, and the human replies/resolves like any other item; those responses reach
the agent through the same watch/prompt loop. This is a *usage pattern*, not a
protocol change — post-then-watch and post-then-move-on both just work.

Each reply/round/re-anchor SSE-pushes so the chip (or the new round) appears
live. Then `r3 watch <id>` again — a back-and-forth loop with no copy-paste. The
**`watch` exit code is the loop's branch signal**: `10` = feedback submitted (act
on it, watch again); `0` = **approved** (terminal success — the human's optional
"next steps" note is printed to stdout); `3` = abandoned; `2` = timed out. So a
naive `while r3 watch; do …` is wrong — branch on `$?`. Ending the loop is the
human's move — `r3 approve <id>` (optionally with `--note "<next steps>"`) or
`r3 abandon <id>`, or the Approve/Abandon buttons in the UI.

**Delivery is tracked** (`sent_at` + `status_unsent`): every hand-off marks the
feedback + human replies it renders sent, so a prompt is **unsent-only** — new
feedback in full plus a compact `(follow-up)` block for any feedback that gained a
human reply since (agent replies never re-appear — the agent wrote them). **The
decision itself is deliverable**: a bare Resolve/Reopen click posts no reply, so a
status flip raises `status_unsent` and the next prompt reports "`[resolved]` — no
action needed" (then clears the flag) — the agent tracks each item to resolution.
Copy/Submit disable once nothing is unsent (a fresh reply or decision re-enables
them); `r3 show <id>` (or `r3 prompt <id> --all`) re-prints the full history
without marking. A restarted `watch` won't re-emit what was already delivered.

`watch` also returns immediately if feedback is already pending; `--timeout <sec>`
(default 0 = never) bounds the wait; `--auto-fetch-timeout <sec>` opts into
auto-send after N idle seconds when no human will click Submit. `--session` is the
UI display name; `--agent-id` a precise machine handle other tools read from
`GET /api/reviews/:id/watchers`.

## Anchoring — keeping feedback from orphaning

**Diff reviews can't orphan by construction**: feedback anchors into an immutable
stored round (`patch_seq` + quote), so nothing drifts and `reanchor` is rejected.
The response side is the **anchored reply** — the agent pins where its fix landed in
a later round (`r3 reply … --diff <seq> …`), validated against the stored patch at
post time and stable forever.

**Files reviews** (`WORKING`/`SCRATCH`) **change under the review**, so keep
anchors fresh from **both sides**:

1. **Automatic (server, `anchor.ts`).** On render / file-change, search for `quote`
   near `line_start`, whitespace-insensitively. Found → relocate + update the
   range + `code_sha`, `anchor='anchored'`. Not found → `anchor='outdated'`, keep
   the original quote, surface "the code this refers to changed." Never silently
   mis-point. **Lazy** (`server/dirty.ts`): re-anchoring re-reads files, so it runs
   only when a review is _dirty_ — the watcher marked a referenced file changed, or
   the review hasn't been anchored this daemon lifetime. An incidental refetch (a
   reply, a status flip) skips it, so an item flips to `outdated` only after a real
   content change.
2. **Explicit (agent, `PATCH /api/feedback/:id/anchor`).** When a restructure
   makes the quote un-findable, the same agent that moved the code tells the
   server where the feedback now belongs (`r3 reanchor`).

Across snapshot/diff views the client **locates each feedback by its quote** among
the diff rows (unchanged/added text lands on the new side, deleted on the old),
keeping feedback **singular** (one item, canonically on the live file) rather than
forking a copy per view.

## HTTP API

Request/response shapes live in `shared/types.ts`; the routes are served by
`server/index.ts` behind the Host + token guards (see Security). **Highlighting
runs server-side** — Shiki for code, markdown-it for `.md` (with per-block
source-line mapping for anchoring) — shipping tokens to the client cached by
content sha, so the WASM/grammar weight never reaches the browser.

- **Browse (read):** `GET /api/git/status | /api/git/log | /api/git/tree |
  /api/diff | /api/blob` — status, paged commit history, file tree at a ref, a
  structured highlighted diff, one rendered file.
- **Reviews:** `GET/POST /api/reviews` — list (queryable by
  `session`/`meta.<k>`/`status`; each row carries a live `watching` flag) / create
  `{ kind, source, meta, title, summary }` → `{ id, url }` (`scratch:true` for a
  scratch review; `patch:'<diff>'` stores a piped diff as round 1).
  `GET /api/reviews/:id` — review + feedback[] (with replies[]) + round + snapshot
  metas. `GET …/diff` — a diff review's rendered rounds. `GET/POST/DELETE
  …/patches[/:seq]` — list / append / drop a round. `POST …/files` — membership
  `{ add?, remove? }`. `GET/POST/DELETE …/snapshots[/:seq]` + `…/snapshot-diff` +
  `…/snapshot-blob` — content snapshots + their derived diffs. `PATCH
  /api/reviews/:id` — edit `{ status?, meta?, title?, summary?, note? }` (`note` →
  `meta.next_steps`); `DELETE /api/reviews/:id`.
- **Hand-off:** `GET …/prompt?feedback=` — the `text/plain` agent prompt (stamps
  `sent_at`). `GET …/watchers` + `POST …/submit` — live `watch` clients / fire a
  `submitted` event.
- **Feedback + replies:** `POST /api/reviews/:id/feedback`, `PATCH
  /api/feedback/:id`, `PATCH /api/feedback/:id/anchor` (re-anchor; files reviews
  only, else 400), `DELETE /api/feedback/:id`; `POST /api/feedback/:id/replies`
  (optional pin validated against the stored round), `PATCH /api/replies/:id`
  (edit the last human message; web-only, no CLI).
- **Live:** `GET /api/events?review=:id[&session=&agentId=]` — SSE
  (`review-updated`, `feedback-updated`, `file-changed`, `watchers-changed`,
  `submitted`, `reviews-changed`); a connection with `session` registers as a
  watcher. `GET/PUT …/viewed` — per-reviewer read progress (no SSE, no CLI).
  Token-free: `/api/health` (liveness), `/api/boot` (same-origin gated, hands out
  the token), `/api/events` (SSE can't set headers).

## CLI surface

`cli/index.ts` is the binary and the agent's entry point; it discovers the daemon
via `$XDG_RUNTIME_DIR/r3/daemon.json` (or `R3_URL`) and every command is one HTTP
call.

```
r3 create --commit <sha> | --diff <base>..<head> | --working | --staged
          | --stdin-diff [--label L] | --files <path|glob>... [--ref <ref>]
          | --scratch                         [--title T] [--summary S] [--meta k=v]...
r3 list   [--meta k=v]... [--status open]
r3 show   <id> [--json]
r3 prompt <id> [--all] [--feedback <fid,...>]      # --all: full history, mark nothing
r3 watch  <id> [--session <name>] [--agent-id <id>] [--auto-fetch-timeout <sec>] [--timeout <sec>]
r3 diff   add <id> [--label L] [--summary S] | list <id> [--json] | rm <id> <seq>
r3 files  add <id> <path|glob>... | rm <id> <path>...
r3 snapshot <id> [--label L] | snapshot list <id> [--json] | snapshot rm <id> <seq>
r3 reply  <feedback_id> -m "<msg>" [--diff <seq> --file <f> --line <a-b> [--quote "<text>"]]
r3 feedback add <id> -m "<msg>" [--file <f> [--line <a-b>] [--quote "<t>"] [--side old|new]]
            [--diff <seq>]                      # agent-authored feedback (see The review loop)
r3 reanchor <feedback_id> --file <f> --line <a-b> [--quote "<text>"]   # files reviews only
r3 edit   <id> [--title "<t>"] [--summary "<s>"]   # "" clears; --summary - = stdin
r3 approve <id> [--note "<next steps>"] | abandon <id>
r3 guide                                            # print the agent orientation text
r3 start | stop | status | restart                 # per-user daemon lifecycle
r3 repo list | repo relink <repo-id> <path> | forget <repo-id>
```

`--meta session=<id>` ties a review to a session; `list --meta session=<id>` lets
an agent find its own reviews. `watch`'s exit code is the loop branch signal (see
The review loop).

## Storage & data files

All under XDG, keyed by `server/config.ts`:

- `$XDG_STATE_HOME/r3/r3.sqlite` — the one global store (reviews + feedback +
  replies + per-reviewer `viewed_marks` + the `repos` registry). `R3_DB` overrides
  (tests).
- `$XDG_STATE_HOME/r3/token` (mode 0600) — the per-user API token (see Security);
  handed to the same-origin page by `/api/boot`, read from `daemon.json` by the CLI.
- `$XDG_STATE_HOME/r3/scratch/<review_id>/` — scratch reviews' file directories
  (legacy single-file docs live as `scratch/<review_id>.md`). Diff rounds live
  in the sqlite `patches` table, not on disk.
- `$XDG_RUNTIME_DIR/r3/daemon.json` (fallback state dir, mode 0600) — `{ url, port,
pid, token, version }`; the CLI's discovery record.
- `$XDG_RUNTIME_DIR/r3/daemon.lock` — O*EXCL start-lock (Bun defaults SO_REUSEPORT
  on, so the port is \_not* a lock); colocated with `daemon.json` so a reboot drops
  both. A stale lock (dead pid) is stolen on next start.

`process-compose.yaml` points both XDG dirs at `workspace/` and uses port 8891, so
the dev stack never collides with a normally-running daemon.

## Viewed-state (per-reviewer read progress)

The GitHub-PR-style "Viewed" fold marker is **server-persisted** in `viewed_marks`
— r3 is single-user, so "have I read this?" is legitimate review state that should
follow you across browsers/devices. The row `key` encodes **content identity**,
not a path: a diff round's file is keyed `d:<seq>:<path>` (immutable rounds ⇒
naturally per-round), a live files-review file `f:<path>@<sha>` (a changed file
gets a new sha ⇒ its old mark stops matching ⇒ the card auto-unfolds). `ON DELETE
CASCADE` drops the marks with the review — no cap/LRU/cleanup. Two
token+same-origin routes (`GET/PUT …/viewed`), no SSE, no CLI — a pure UI
affordance that does **not** bump `review.updated_at` (`web/src/viewed.ts` writes
optimistically so the fold is instant).

## Security

- Binds **`127.0.0.1`** by default (`R3_BIND` to override — an explicit opt-in).
- Every request **that returns data or the token** — i.e. all of `/api/*`,
  including `/api/boot` — must carry a **Host** that is loopback or an allowlisted
  name (`R3_ALLOWED_HOSTS`, exact names, never `*`): the DNS-rebinding defense.
  The **static SPA shell + hashed JS/CSS/favicon** are served natively by
  `Bun.serve`'s `routes` _outside_ this Hono guard — that's fine because they
  carry no secrets and grant no capability (the app is inert until the
  Host-gated `/api/boot` hands it the token). Never let a data/token endpoint
  out from behind the guard.
- **Every `/api` data endpoint requires the per-user token** — reads as well as
  writes. The token + `/api/boot` gate defend against **browser-borne** attack
  (DNS-rebinding pages, cross-origin `fetch`) and casual remote access — **not**
  against other local UIDs: `/api/boot`'s same-origin check passes any request that
  carries no `Origin` header (as `curl` sends none), so any local process of any UID
  can read the token and then use every endpoint. A real local-user boundary would
  need an OS-level peer-credential check on `/api/boot`. The only token-free
  endpoints are `/api/health` (liveness), `/api/boot` (hands the same-origin page
  the token, so it's same-origin gated instead), and `/api/events` (SSE).
  **Mutating routes** (POST/PATCH/DELETE) additionally require **same-origin**.
  `sameOrigin()` dropped the port pin (so a forward/proxy that changes the port
  still passes) and leans on the Host allowlist + token.
- **Path inputs** are validated against the requesting review's **worktree** root
  (or the scratch root for `SCRATCH`) — repo-relative, no `..`, no absolute.
- **Git arg-injection guard**: reject refs/paths beginning with `-` before they
  reach git (an option like `--output=<file>` would write a file).
- Remote access keeps this model: loopback + `ssh -L 8791:localhost:8791`, or
  `tailscale serve` (r3 stays on loopback — prefer it over binding the tailnet IP
  so TLS terminates at Tailscale and identity headers stay available for future
  per-user auth). **Never bind `0.0.0.0`.**

## Build & distribution

- **Single-file binary.** `bun run build` runs one `Bun.build({ compile })`
  (`scripts/compile.ts`) over the CLI entry — which imports the daemon, which
  imports the SPA via `import index from "../web/index.html"` — embedding the Bun
  runtime, all JS deps, `bun:sqlite`, and the bundled SPA (as `Bun.embeddedFiles`)
  into one `./r3` executable that serves its own UI. The SPA stylesheet is
  Tailwind-compiled first in a separate **browser-target** pass (`scripts/spa-css.ts`,
  shared with `release-binaries.ts`): a compile build is `target:"bun"`, whose CSS
  printer keeps Tailwind's native nesting verbatim, and un-lowered nesting breaks
  in browsers (`& {…}` under `::placeholder` is unmatchable — placeholders lose
  their dimming). The pre-pass lowers it flat; the compile build embeds it as-is.
- **Two release channels off one tag-driven pipeline** (`release-binaries.ts`
  cross-compiles the four `r3-<os>-<arch>` binaries + `SHA256SUMS`): **GitHub
  Releases** carry the raw assets (curl / Homebrew); **npm** ships a tiny launcher
  (`@hyperlogue/r3`, `npm/launch.mjs`) whose per-platform binaries are
  **optional-dependency packages** (`@hyperlogue/r3-<os>-<arch>`, staged by
  `stage-npm-packages.ts`). npm installs only the matching package, so
  `bunx`/`npx @hyperlogue/r3@x.y.z` resolves-and-execs that version's binary with
  **no runtime download** (the launcher only does `createRequire().resolve` +
  `spawn`).
- **`package.json` overrides `bun` → `empty-npm-package`.** `bun-plugin-tailwind`
  peer-depends on the `bun` npm package, which would pull Oven's wrapper + 16
  platform binaries into bun.lock (and thus bun.nix and the nix build's fetch set)
  and whose broken bin shim shadows `bun` on install-script PATHs. The override
  pins that name to an empty stub. The plugin has no public source repo — report
  issues to oven-sh/bun, and drop the override if a release marks the peer
  optional or moves it to `engines`.
- **Heritage.** v1 was one server per repo with a gitignored per-repo
  `.r3/review.sqlite`; v2 replaced it with the one per-user daemon + global store
  described above. Some code comments still cite the old model as history.

## Dev commands

```sh
bun install                 # deps (direnv runs this automatically via .envrc)
bun run dev                 # daemon with --watch + Bun HMR (R3_DEV=1 bun --watch server/index.ts)
process-compose up          # the dev daemon, isolated to workspace/ on port 8891
bun cli/index.ts <cmd>      # drive the CLI against the running daemon (lazily spawns one)
bun run storybook           # component workshop on :6007 (process-compose up storybook)
bun run build               # Bun.build --compile -> single ./r3 binary (embeds the SPA)
```

- **Nix + direnv**: `direnv allow` (or `nix develop`) gives bun and biome.
- **The daemon bundles + serves the SPA itself** — `Bun.serve`'s `routes` serve the
  `import index from "../web/index.html"` bundle. `R3_DEV=1` turns on Bun's HMR
  (`development:{hmr:true}`): edit `web/src` and the browser hot-reloads with **no
  daemon restart and no separate build step** (`bun run dev` sets it; `bun --watch`
  restarts only on server-file edits). Vite is **Storybook-only** (its own
  `.storybook` config).
- **A from-source daemon is spawned with the r3 repo as its `cwd`** (`spawnDaemon`
  in `cli/index.ts`): Bun resolves `bunfig.toml` — which registers
  `bun-plugin-tailwind` for the static SPA bundle — from the cwd, so a daemon
  lazily spawned in some other repo wouldn't find it and the SPA's `@import
"tailwindcss"` would fail to bundle (blank page). Purely a build concern — the
  daemon is repo-agnostic (see Architecture), so cwd carries no product meaning.
  The bounded cwd is also what makes HMR safe on a lazily-spawned daemon (the
  watcher can't crawl an arbitrary huge repo and exhaust fds). The compiled binary
  embeds the SPA (no bundling, no bunfig), so its cwd is irrelevant — it inherits
  the CLI's.

## Checks (there is no unit-test runner)

Before committing, run:

```sh
bun run typecheck           # tsc --noEmit across server + cli + web + shared
biome check .               # lint + format (biome is in the nix shell, not a devDep)
biome check --write .       # apply fixes
```

Components have **Storybook stories** (`*.stories.tsx`) as the visual test surface
— add/update a story when you change a component. Config lives in `biome.jsonc`
(2-space, width 100, double quotes; a few rules are deliberately off — see the
comments there).

## Committing

- **Work on `main` directly** — this repo doesn't use feature branches for routine
  work.
- **Conventional Commits with a subsystem scope**: `feat(web): …`, `fix(web): …`,
  `feat: …`, `chore: …`, `daemon: …`, `doc: …`. Imperative subject, ≤72 chars, no
  trailing period. One logical change per commit.
- **Body** (blank line, wrapped ~72) when the _why_ isn't obvious — explain the
  motivation / constraint, don't narrate the diff. Note any verification you ran.
- **Keep the `Co-Authored-By: Claude …` trailer** — this repo uses it (unlike some
  sibling repos that strip it).
- Commit only your own files by path; commit once the work is complete and checks
  pass; leave `git push` to the user unless they ask.

## House rules

- **The HTTP/JSON API is the product**, not a detail of the React client — when you
  change behavior, change `shared/types.ts` and keep server + CLI + web in sync.
- **The server is authoritative**; the CLI is a thin client. Don't add a second
  sqlite writer.
- **The Repo context is per-request** (`server/repo.ts`) — don't reintroduce module
  globals for paths/git/db. `git()` runs in the review's worktree; `safePath()`
  validates against it.
- **Never weaken the security posture** (see Security above). Never bind `0.0.0.0`.
- **Anchoring is quote-first** (the line number is a hint) — preserve the
  automatic-relocate + explicit-reanchor behavior when touching `anchor.ts` /
  render / watch.
- **Diff rounds are immutable** — never add an edit-a-patch path; changes arrive
  as new rounds, and feedback/reply pins into a stored round must stay valid
  forever (that's what makes them trustworthy).
- **This file is the design source of truth** — update the relevant section here
  when a design decision changes.
- **Keep `r3 guide` accurate** — the `GUIDE` text in `cli/index.ts` is the
  agent-facing orientation that sibling repos defer to instead of duplicating, so
  a stale guide silently mis-instructs every agent in every repo. Any commit that
  changes the CLI's public interface — a command, a flag, output shape, or the
  review-loop protocol — must re-check `GUIDE` (and `HELP`) in the same commit.
