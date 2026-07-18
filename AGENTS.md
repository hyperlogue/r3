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
  auth.ts        quick-auth: login tokens -> HttpOnly session cookies (only when REQUIRE_LOGIN)
  scratch.ts     adhoc scratch-review storage (ref:'SCRATCH') outside any repo
  paths.ts       pure safePathIn(root, p) path guard    ids.ts  id minting
cli/index.ts     thin HTTP client + daemon lifecycle — the agent's entry, the binary
web/             React 19 + TanStack Query + Tailwind v4 SPA (bundled by Bun)
  src/pages/     Home.tsx (the reviews list — the `/` landing view), ReviewView.tsx (the review)
  src/components/ DiffView, FileView, FileCard, FileBrowser, FeedbackPanel,
                 ReviewSwitcher (navbar "Reviews" breadcrumb), SettingsPopup,
                 ReviewSummary, SnapshotSelect, Logo, Login (remote-access token
                 screen), TokenManager (login-token panel in SettingsPopup),
                 JumpToFile (toolbar file picker: popover on desktop, bottom
                 sheet below md), Message (MessageProse +
                 the shared QuoteBubble/useQuoteBubble selection-to-quote)
                 (each with a *.stories.tsx)
  src/mobile/    the phone tier's containers ONLY (see Mobile): useIsMobile +
                 MobileReviewChrome (bottom bar + the 3-state feedback sheet);
                 desktop components never import from here
  src/api.ts     typed fetch wrappers    hooks.ts  SSE + query wiring
  src/markdown.ts client Markdown render (markdown-it, html:false) + @path:Lx-y refs
  src/viewed.ts  server-backed per-round/per-sha "viewed" fold-state
  src/drafts.ts  per-review composer drafts (localStorage)   selection.ts  range select
  router.ts      tiny pathname router (`/` reviews list, `/review_<id>` a review);
                 base-aware (`hrefFor`) so the demo can mount under a sub-path   ui.tsx  shared UI
  demo/          the frontend-only demo's in-browser backend (see Build & distribution):
                 api.ts (aliased over web/src/api.ts) + backend/store/bus/agent/watchers +
                 fixtures.gen.ts (baked seed) — no daemon, no git, all in the browser
shared/types.ts  the HTTP contract (domain model + request/response shapes)
shared/version.ts build version — /api/health reports it; the CLI warns on skew
scripts/compile.ts  one `Bun.build({compile})` — bundles+embeds the SPA -> ./r3 binary
scripts/spa-css.ts  browser-target Tailwind CSS pre-pass for compile builds (de-nests)
scripts/release-binaries.ts  cross-compile dist/r3-<os>-<arch> + SHA256SUMS for a release
scripts/stage-npm-packages.ts  stage the 4 per-platform npm binary packages + stamp launcher pins
scripts/gen-demo-fixtures.ts  bake the demo seed (rendered Shiki/markdown HTML) -> web/demo/fixtures.gen.ts
scripts/build-demo.ts  Bun.build the frontend-only demo -> dist/demo (sub-path aware)
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
  agent's own prompts — only the human's replies/resolution flow back; it wears an
  `[agent-authored]` label in prompt blocks (and `[agent]` in `r3 show`) and
  doesn't gate the UI's Approve button (only the human's open items do). Fields:
  `file`, `side` (`old|new|null`), `line_start/end`,
  `quote` (**the anchor of record** — the line number is only a hint; for a
  line-anchored `r3 feedback add` without `--quote` the server derives it from
  the round/live content, rejecting a range that isn't fully within what the
  round/file shows (partial or hunk-gap-spanning) rather than storing a driftable
  quote-less anchor, and capping the derived quote at `MAX_QUOTE_LINES` like the
  web's selection anchors; a whole-file or quoted anchor gets its path validated
  against the review — round contents / file membership — so no dangling note is
  stored), `code_sha`
  (recorded at anchor time; staleness surfaced via `anchor`), `anchor`
  (`anchored|outdated`), `patch_seq` (which round, for diff reviews; a
  line-anchored note naming no round lands in the latest), `status`
  (**`open|resolved`** — two states, human-driven; open = needs attention,
  resolved = done, and the _why_ — fixed, answered, dismissed — lives in the
  thread, not the enum). The agent references feedback by its
  **stable `id`** (`feedback_<short>`), never a positional index. Two span-less
  variants exist: a **summary** note (`file` is the `SUMMARY_FILE` sentinel
  `@summary`; `patch_seq` names a round's summary, null = the review summary; shown
  as "review summary" / "diff N summary") and a **whole-file** note (a real `file`
  path with `line_start`/`line_end`/`quote` all null; shown as "`<path>` (whole
  file)"). The automatic re-anchor pass skips both (no worktree span behind them);
  the whole-file note and the immutable **round**-summary note are never
  re-anchored, but the **review**-summary note (edited in place, so its quote can
  drift) is **agent-re-anchorable by quote** — the one exception (see Anchoring).
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
drops it in as a `>` blockquote instead. **Both summaries — the review summary
(`ReviewSummary`) and the active round's summary (`RoundSummary`, in
`DiffView.tsx` but mounted by `ReviewView`: desktop at the top of the scroll
pane, mobile as the pane toolbar's middle row) — render the same way** (markdown
+ refs, same prose type treatment); a round-summary ref resolves against its
round, a review summary is edited in place so its refs pin no version and
resolve against the **live/current view**.

**Select-to-feedback is one gesture everywhere** — the file/diff pane, the round
summary, and the review summary all route a text selection through the same
`applyAnchorGesture` (`ReviewView`): an **empty composer anchors** a note to the
selection; a **composer already holding text** raises a **"Quote in note"** bubble
instead (drops the selection as a `>` blockquote, never clobbers). A summary
selection anchors a `@summary` note by **quote** (the rendered markdown has no
stable source offsets, so the quote is the whole anchor and line numbers are a
best-effort hint); an active summary note is located by finding its quote in the
rendered prose (`mdhighlight.rangeForQuote`), best-effort, falling back to flashing
the whole block when it can't be found. Because the review summary is mutable, its
note can drift and is agent-re-anchorable; round-summary anchors are immutable.

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
status flip **of a delivered item** raises `status_unsent` and the next prompt
reports "`[resolved]` — no action needed" (then clears the flag) — the agent
tracks each item to resolution. An undelivered item owes nothing extra: an open
one delivers in full with its current status, and a note resolved before any
hand-off is settled without the agent ever seeing it. Copy/Submit disable once
nothing is unsent (a fresh reply or decision re-enables them); `r3 show <id>` (or
`r3 prompt <id> --all`) re-prints the full history without marking. A restarted
`watch` won't re-emit what was already delivered. The unsent predicate lives once
in `shared/types.ts` (`hasUnsentContent`) — the server's prompt, the CLI's
`watch`/`prompt`, and the web's Copy/Submit gate all call the same function.

`watch` also returns immediately if feedback is already pending; `--timeout <sec>`
(default 0 = never) bounds the wait; `--auto-fetch-timeout <sec>` opts into
auto-send after N idle seconds when no human will click Submit. `--session` is the
UI display name; `--agent-id` a precise machine handle other tools read from
`GET /api/reviews/:id/watchers`.

## Anchoring — keeping feedback from orphaning

**Diff reviews can't orphan by construction**: file/round feedback anchors into an
immutable stored round (`patch_seq` + quote), so nothing drifts and `reanchor` is
rejected (the review summary is the one exception — see below). The response side
is the **anchored reply** — the agent pins where its fix landed in a later round
(`r3 reply … --diff <seq> …`), validated against the stored patch at post time and
stable forever.

**Summaries anchor by quote.** A `@summary` note has no worktree span, so the
automatic pass skips it and the client locates it by finding the quote in the
rendered prose (`mdhighlight.rangeForQuote`, best-effort; whole-block flash when it
can't be found). A **diff-round** summary is immutable → its quote can't drift and
`reanchor` stays rejected; the **review** summary is edited in place (`r3 edit
--summary`) → its note can drift, so it's the one `@summary` note the agent
re-points, on any review kind: `r3 reanchor <fid> --quote "<new text>"` (quote is
the whole anchor; `--line` is an optional best-effort hint).

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
  /api/feedback/:id`, `PATCH /api/feedback/:id/anchor` (re-anchor; a files-review
  file anchor, or a review-summary note by `quote` on any kind — diff file/round
  anchors and round summaries are immutable, else 400), `DELETE /api/feedback/:id`;
  `POST /api/feedback/:id/replies`
  (optional pin validated against the stored round), `PATCH /api/replies/:id`
  (edit the last human message; web-only, no CLI).
- **Live:** `GET /api/events?review=:id[&session=&agentId=]` — SSE
  (`review-updated`, `feedback-updated`, `file-changed`, `watchers-changed`,
  `submitted`, `reviews-changed`); a connection with `session` registers as a
  watcher. `GET/PUT …/viewed` — per-reviewer read progress (no SSE, no CLI).
- **Auth (quick-auth):** `GET /api/boot` bootstraps the SPA — when `REQUIRE_LOGIN` is
  off (config.ts) it returns the per-user `token`; when on it needs a
  login-token session and answers `401 { needsAuth }` otherwise. `POST
  /api/auth/login { token }` trades a login token for an HttpOnly cookie; `POST
  /api/auth/logout` ends it. `GET/POST /api/auth/tokens` + `DELETE
  /api/auth/tokens[/:id]` list / mint / revoke (one or all) login tokens — the CLI
  `r3 auth …` and the settings UI share them. The list flags the caller's **own**
  token (the one behind its session cookie) `current:true` so the UI disables its
  revoke, and `DELETE …/:id` **refuses that token** (`409`) — revoking it would
  delete the caller's live session and lock them out mid-request; a master-token
  caller carries no cookie, so nothing is `current`. Bulk `DELETE …/tokens`
  (revoke-all) is the deliberate escape hatch and isn't guarded. Token-free (still Host-gated):
  `/api/health`, `/api/boot` (same-origin), `/api/auth/login` (same-origin), and
  `/api/events` **only when not exposed**. **Everything else** — reads, all
  mutations, and `/api/events` once exposed (a session cookie rides EventSource) —
  requires the per-user token **or** a valid session cookie.

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
r3 reanchor <feedback_id> --file <f> --line <a-b> [--quote "<text>"]   # files-review anchor
r3 reanchor <feedback_id> --quote "<new text>" [--line <a-b>]          # review summary (any kind)
r3 edit   <id> [--title "<t>"] [--summary "<s>"]   # "" clears; --summary - = stdin
r3 approve <id> [--note "<next steps>"] | abandon <id>
r3 auth create-token [--label L] | list-tokens [--json] | revoke-token <id> | --all
r3 guide                                            # print the agent orientation text
r3 start | stop | status | restart                 # per-user daemon lifecycle
r3 repo list | repo relink <repo-id> <path> | forget <repo-id>
```

`r3 auth` manages the login tokens that open the web UI when the daemon is exposed
beyond loopback (a `tailscale serve` name / bound IP / `R3_REQUIRE_LOGIN`); a
loopback-only daemon needs none. `create-token` prints the token once (hashed at rest).

`--meta session=<id>` ties a review to a session; `list --meta session=<id>` lets
an agent find its own reviews. `watch`'s exit code is the loop branch signal (see
The review loop).

## Storage & data files

All under XDG, keyed by `server/config.ts`:

- `$XDG_STATE_HOME/r3/r3.sqlite` — the one global store (reviews + feedback +
  replies + per-reviewer `viewed_marks` + the `repos` registry + the quick-auth
  `auth_tokens` / `auth_sessions` — login tokens hashed at rest, and the browser
  session cookies they mint, also hashed). `R3_DB` overrides (tests).
- `$XDG_STATE_HOME/r3/token` (mode 0600) — the per-user API token (see Security);
  handed to the same-origin page by `/api/boot` (only when not exposed), read from
  `daemon.json` by the CLI. Distinct from the user-created **login tokens** above.
- `$XDG_STATE_HOME/r3/scratch/<review_id>/` — scratch reviews' file directories
  (legacy single-file docs live as `scratch/<review_id>.md`). Diff rounds live
  in the sqlite `patches` table, not on disk.
- `$XDG_RUNTIME_DIR/r3/daemon.json` (fallback state dir, mode 0600) — `{ url, port,
pid, token, version, exec, argv }`; the CLI's discovery record. `exec`/`argv` are
  the serving process's own `process.execPath` / `process.argv` (the binary +
  command line actually running), surfaced by `r3 status`.
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

## Mobile (the phone tier)

Phones are **not first-class** — no productive authoring expected — but reading
code, switching rounds/snapshots, reading feedback, resolve/submit, replying, and
adding feedback all work below Tailwind `md` (768px; portrait tablets keep the
desktop layout). The **prime rule: isolate, don't interleave** — mobile must not
add complexity to desktop code. All mobile UI lives in `web/src/mobile/` (desktop
components never import from it); existing components get only inert `max-md:` /
`pointer-coarse:` class tweaks; the **single mount point** is `ReviewView`, which
swaps the side dock for `MobileReviewChrome` — panel/domain state never forks,
and the same `FeedbackPanel` renders with the same props either way.

- **Layout**: the sidebar hides; the pane toolbar wraps into stacked full-width
  rows — round/snapshot selector (full-bleed trigger, chevron far right) · the
  round summary · the buttons; a persistent bottom bar (`Feedback · N open`, the
  whole bar is the toggle — watcher presence shows only inside the panel)
  toggles a bottom **sheet** hosting the panel, with three discrete tap-only
  states — closed · **composer peek** (short sheet: the composer over the
  still-visible code; raised by any anchor gesture) · full. Locate/ref jumps
  close the sheet before scrolling the code pane.
- **Navigation**: the shared `JumpToFile` picker (a toolbar button on both
  tiers) — flat filterable list with viewed ticks, filter input pinned at the
  bottom, Enter jumps to the top match; popover on desktop, sheet below `md`.
- **Pending** (design in review_ac97a7745990): touch anchoring (line-number tap
  + a selection "Add feedback" pill), then ergonomics polish (44px targets, 16px
  inputs, `pointer-coarse:` hover-reveal audit, gutter compression).

## Security

- Binds **`127.0.0.1`** by default (`R3_BIND` to override — an explicit opt-in).
- Every request **that returns data or the token** — i.e. all of `/api/*`,
  including `/api/boot` — must carry a **Host** that is loopback, an allowlisted
  name (`R3_ALLOWED_HOSTS`, exact names, never `*`), or the **advertised public
  host**: the DNS-rebinding defense. The public host is derived from `R3_PUBLIC_URL`
  and allowed implicitly (config.ts) — since r3 hands that URL out, it must resolve,
  so a single `R3_PUBLIC_URL=https://<name>` is enough for `tailscale serve` (no
  separate `R3_ALLOWED_HOSTS` for the common one-host case). The **static SPA shell +
  hashed JS/CSS/favicon** are served natively by `Bun.serve`'s `routes` _outside_
  this Hono guard — that's fine because they carry no secrets and grant no capability
  (the app is inert until the Host-gated `/api/boot` bootstraps it). Never let a
  data/token endpoint out from behind the guard.
- **Every `/api` data endpoint requires the per-user token _or_ a valid session
  cookie** (`resolveAuth`) — reads as well as writes. This defends against
  **browser-borne** attack (DNS-rebinding, cross-origin `fetch`) and casual remote
  access — **not** against other local UIDs: `/api/boot`'s same-origin check passes
  any request with no `Origin` header (as `curl` sends none), so when the daemon
  isn't exposed any local process of any UID can still fetch the token. A real
  local-user boundary needs an OS-level peer-credential check. Always token-free:
  `/api/health`, `/api/boot` (same-origin gated), `/api/auth/login` (same-origin
  gated — you have no session yet). `/api/events` (SSE) is token-free **only when
  not exposed** (loopback-only, EventSource can't set headers); when exposed a
  session cookie rides EventSource, so it's gated like any read. **Mutating routes**
  (POST/PUT/PATCH/DELETE) additionally require **same-origin**. `sameOrigin()`
  dropped the port pin (so a forward/proxy that changes the port still passes) and
  leans on the Host allowlist + token/cookie.
- **Quick-auth (login token → session cookie)** is an **optional login gate** — pure
  security hardening — on the zellij model (server/auth.ts), gated by ONE startup
  policy: **`REQUIRE_LOGIN`** (config.ts). It's a *login policy*, not a detected fact
  — r3 can't tell a truly-local client from a proxied one (a reverse proxy rewrites
  `Host`/`Origin`), so it's decided once at startup and defaults **on whenever any
  non-loopback access is configured**: a non-loopback (or wildcard) bind, a
  non-loopback `R3_PUBLIC_URL`, or any non-loopback `R3_ALLOWED_HOSTS` name — allowing
  a remote Host is itself the signal. `R3_REQUIRE_LOGIN` (1/0) forces it either way.
  **Login not required** (default): the daemon binds loopback, every client is already
  local, so `/api/boot` hands the same-origin page the per-user token — no login,
  unchanged. **Login required**: the web UI wants a **login token**
  (`r3 auth create-token`, hashed at rest, shown once, revocable) for *every* session,
  incl. the operator's own localhost. `/api/boot`
  returns `401 { needsAuth }` until `/api/auth/login` trades the token for an
  **HttpOnly, SameSite=Strict** cookie (Secure when the edge is HTTPS, from
  `X-Forwarded-Proto`). The **master token never reaches a browser** when login is
  required — it's cookie-only. Revoking a login token deletes its sessions
  immediately. The per-user token stays the CLI's credential, unaffected.
  A **Host-rewriting reverse proxy** is the blind spot of this default: it's derived
  from r3's own bind + advertised host, so a proxy
  that forwards `Host: 127.0.0.1` (nginx's default `proxy_pass`) reads as
  loopback-only, and `/api/boot` would hand a remote browser the per-user token —
  r3 can't see the real client name, and a naive proxy sends no `X-Forwarded-*` to
  key off either. Any roll-your-own reverse-proxy deployment must set
  `R3_REQUIRE_LOGIN=1` (or point `R3_PUBLIC_URL`/`R3_ALLOWED_HOSTS` at the public
  name, which arms the gate); `tailscale serve` forwards the real Host, so
  `R3_PUBLIC_URL` alone covers it.
- **Path inputs** are validated against the requesting review's **worktree** root
  (or the scratch root for `SCRATCH`) — repo-relative, no `..`, no absolute.
- **Git arg-injection guard**: reject refs/paths beginning with `-` before they
  reach git (an option like `--output=<file>` would write a file).
- Remote access keeps this model: loopback + `ssh -L 8791:localhost:8791` (you
  browse `localhost`, so the daemon isn't exposed → still zero-friction, no login),
  or `tailscale serve` (r3 stays on loopback — prefer it over binding the tailnet IP
  so TLS terminates at Tailscale and identity headers stay available for future
  per-user auth). For the tailscale case, set `R3_PUBLIC_URL=https://<magicdns-name>`
  (which auto-allows that Host **and** marks the daemon exposed) and
  `r3 auth create-token`; browsers then log in with that token. **Never bind
  `0.0.0.0`.**

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
- **Frontend-only demo → GitHub Pages.** `bun run build:demo` (`scripts/build-demo.ts`)
  produces a static `dist/demo/` that runs the **whole SPA with no daemon** — a
  third client of the same components, but its "backend" is an **in-browser store**
  (`web/demo/`) over `localStorage`. It's the *same* `web/index.html` Bun.build,
  with one `onResolve` alias swapping `web/src/api.ts` → `web/demo/api.ts` (so every
  fetch/SSE call hits the browser backend) and an `EventSource` shim; the demo
  reuses the server's genuinely *pure* modules verbatim (`anchor.ts`, `textdiff.ts`,
  `prompt.ts`, `shared/types.ts`) and **pre-bakes** all Shiki/markdown HTML at build
  time (`gen-demo-fixtures.ts`), so **no highlighter, sqlite, or git ships to the
  browser**. The seed dogfoods r3 on its own code; a scripted agent watches each
  review and closes the submit→reply→round loop. `.github/workflows/pages.yml`
  builds it and deploys to Pages on push to `main`, mounting it at
  **`…/r3/demo/`** — the project page (`/r3/`, the repo name, forced by Pages) plus
  a `/demo` sub-path. `R3_DEMO_BASE=<base_path>/demo` (base_path from
  configure-pages) bakes that prefix into the router (`hrefFor`/`__R3_BASE__`) and
  asset `publicPath`, then `stage-pages.ts` lays out `dist/pages`: the build under
  `demo/`, a root→demo redirect, and — because **Pages honors only a single
  site-root `404.html`** (subdirectory ones are ignored) — the SPA copied to the
  site-root `404.html` so a deep-link reload of `/r3/demo/review_x` still boots it
  (its asset URLs are absolute). Local `build:demo` defaults to root base so
  `bunx serve -s dist/demo` just works. Reviews can't be *created* in the demo (no
  git) — it's a read-and-respond tour of the seeded reviews. **The demo must never
  fork the contract**: it implements `shared/types.ts`, it doesn't extend it.
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
bun run gen:demo            # re-bake the demo seed fixtures (only after editing canned content)
bun run build:demo          # Bun.build the frontend-only demo -> dist/demo (serve: bunx serve -s dist/demo)
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
