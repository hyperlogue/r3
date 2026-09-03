# r3 — Review. Revise. Resolve.

A **local-first review tool for AI-generated code and docs**. A long-running
per-user daemon on localhost owns review + feedback state for all your repos;
reviews are created from the CLI/agent, and you review the commits, diffs, and raw
files they capture in the browser and leave line/quote-anchored **feedback**; an AI
agent (or you) **replies** by id and the decision shows up **live** over SSE. The
daemon, CLI, and SPA ship as one self-contained binary.

For usage see [`README.md`](README.md). This file is the orientation map for
working _in_ the repo **and the source of truth for its design**, together with the
deep-reference skills it points at (see [Deep reference](#deep-reference)) — when a
design decision changes, update the relevant section here or in the skill that owns
it.

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

- **One per-user daemon** spans every repo, on a stable port (default 8791), behind
  one origin. It's spawned **lazily** on the first CLI call à la the tmux server —
  nothing to start by hand — and announces itself in
  `$XDG_RUNTIME_DIR/r3/daemon.json` so the CLI finds it with zero config.
- **The CLI is the single entry point and the binary.** `cli/index.ts` is a thin
  HTTP client — every review command is one HTTP call (only daemon lifecycle,
  `config`, and `guide` stay local); it never writes sqlite directly (single
  writer, the server stays authoritative). A hidden `__daemon` subcommand re-execs
  the same script/binary to _serve_; `ensureServer()` discovers-or-lazily-spawns it.
- **Reviews live in one global sqlite** (`$XDG_STATE_HOME/r3/r3.sqlite`) keyed by a
  **projects registry**, not per-repo files. A project's identity is its **shared
  git object store** (`realpath(git rev-parse --git-common-dir)`), so all worktrees
  of one clone are one project and a `cp -r` copy is a distinct empty one.
- **The server core is de-globalized** into a per-request `Repo` context
  (`server/repo.ts`): `{ repoId, commonDir, worktreePath, descriptor, stale, git(),
  gitText(), safePath() }`. `git()` runs with `cwd = worktreePath`; `safePath()`
  validates against it. The global sqlite is the only process-wide singleton.
- **The daemon is repo-agnostic** — no ambient "default repo". Each request
  resolves its `Repo` fresh, most-specific first: a `?review=<id>` (the row carries
  its repo), the CLI's `x-r3-repo` header (computed per call from the CLI's own
  checkout), or the browser's `?repo=<id>` selector. A request that names none gets
  `null` → `400 "no repo context"`; the CLI fails `r3 create` outside a git repo up
  front rather than letting it reach the daemon for the same answer.
- **Freshness + live updates** flow one way to the clients: a file watcher
  (`server/watcher.ts`) watches only the files open reviews reference and pushes
  `file-changed`; every review/feedback/reply write broadcasts over SSE
  (`server/sse.ts`) and bumps `review.updated_at` — which is what orders the reviews
  list. The SPA invalidates its TanStack Query cache on the matching event.

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
  config.ts      XDG discovery: daemon.json, token, start-lock, bind/allowlist, URLs;
                 persisted exposure config.json (readConfig/writeConfig, below env)
  repo.ts        per-request Repo context: identity, registry, worktree resolution
  db.ts          global store + repos registry + reviews/feedback/replies/claims CRUD
  git.ts         git ops (log/tree/diff/status) + unified-diff parser + content reads
  reviews.ts     domain logic: create/list/detail, re-anchoring, rounds, membership
  patches.ts     stored diff rounds: parse/validate/render + reply-pin checks
  snapshots.ts   files-review content snapshots: capture + derived-diff render
  textdiff.ts    in-process line differ (Myers SES + prefix/suffix trim) -> DiffFileChange
                 + rehunk(): regroup rows at N context lines, marking each hunk
                 with the held-but-hidden `expandable` counts
  anchor.ts      quote relocation — keep feedback from orphaning
  mdproject.ts   the markdown-it instance + rendered-text projection of a .md
                 (what the browser shows, mapped back to source lines) — the
                 first projection anchor.ts searches; Shiki-free so the demo's
                 backend mirror can import it
  dirty.ts       lazy re-anchor gate: only re-anchor a review whose files changed
  highlight.ts   Shiki (code + a doc's fenced blocks) + markdown render
                 (decorates mdproject's instance with images/doclinks/fence/
                 data-line rules), content-sha cached; token colours ship as
                 palette classes + one per-theme stylesheet (ThemeStyle.css)
  highlight-worker.ts  Shiki tokenizer isolate — codeToTokens off the daemon's
                 thread, so a big blob can't stall SSE / a blocked `r3 watch`
  compress.ts    gzip for the JSON reads (jsonCached) — deflate on libuv's pool
                 past 256KB, for the same reason: a multi-MB body must not
                 block the loop the SSE frames go out on
  mermaid.ts     mermaid fence → safe SVG (flowchart + sequenceDiagram);
                 anything else falls through to the ordinary code fence
  render.ts      raw-file render for kind:'files' (renderFile + renderContent)
  prompt.ts      the agent-prompt text (same as the UI's "Copy prompt")
  sse.ts         pub/sub broadcast    watcher.ts   review-scoped file watching -> SSE
  watchers.ts    live `watch` presence registry — the one watch slot per review
  auth.ts        quick-auth: login tokens -> HttpOnly session cookies (only when REQUIRE_LOGIN)
  scratch.ts     adhoc scratch-review storage (ref:'SCRATCH') outside any repo
  paths.ts       pure safePathIn(root, p) path guard    ids.ts  id minting
cli/index.ts     thin HTTP client + daemon lifecycle — the agent's entry, the binary
web/             React 19 + TanStack Query + Tailwind v4 SPA (bundled by Bun)
  src/pages/     Home.tsx (the reviews list — the `/` landing view), ReviewView.tsx
  src/components/ DiffView, FileView, FileCard, FileBrowser, FeedbackPanel,
                 ReviewHeader (status pill · editable title · copyable meta ·
                 Approve/⋯ actions), PaneToolbar (the file-nav strip above the
                 pane), ReviewSwitcher (navbar "Reviews" breadcrumb), SettingsPopup,
                 ReviewSummary + DiffView's RoundSummary (both thin wrappers over
                 the shared SummaryBar), SnapshotSelect, Logo, Login (remote-access
                 token screen), TokenManager (login-token panel in SettingsPopup),
                 JumpToFile (toolbar file picker: popover on desktop, bottom
                 sheet below md), Message (MessageProse + the shared
                 QuoteBubble/useQuoteBubble selection-to-quote), ShortcutsOverlay
                 (the `?` cheat sheet, rendered from KEYMAP)
                 (each with a *.stories.tsx, except the shared SummaryBar)
  src/mobile/    the phone tier's containers ONLY (mobile-tier skill): useIsMobile +
                 usePointerCoarse, MobileReviewChrome, AddFeedbackPill; desktop
                 components never import from here
  src/api.ts     typed fetch wrappers    hooks.ts  SSE + query wiring
  src/highlights.ts imperative feedback-highlight hooks (active-line ring, summary
                 quote, region wash) + markdown click refinement
  src/pane.ts    content-pane helpers: retrying row jump, composer focus, crossfade
  src/virtual.tsx per-file row virtualization inside the one scroll pane; the
                 mounted window snaps to 48-row blocks and drives virtual-core
                 itself (below), so a scroll doesn't mutate the DOM every frame
  src/progressive.tsx large-review body hydration (files AND diff rounds): one
                 observer, measured offscreen file shells, explicit-jump activation,
                 and the ReserveSpec -> px height a not-yet-mounted shell stands in
  src/expand.ts  expand-context: a diff's collapsed gaps -> revealed rows, merged
                 back into ONE row list everything else derives from
  src/gutter.ts  line-number pick/drag anchoring    resolveFeedback.ts  place a
                 feedback into a snapshot/round diff by quote
  src/mdhighlight.ts quote ranges in rendered markdown (CSS Custom Highlight)
  src/markdown.ts client Markdown render (markdown-it, html:false) + @path:Lx-y refs
  src/doclinks.ts a reviewed .md's relative links -> a jump to that file's card
  src/keys.ts    the keyboard layer: one flat KEYMAP + one window listener; feeds
                 both the dispatcher and the `?` overlay
  src/viewed.ts  server-backed per-round/per-sha "viewed" fold-state
  src/drafts.ts  per-review composer drafts (localStorage)   selection.ts  range select
  router.ts      tiny pathname router (`/` reviews list, `/review_<id>` a review);
                 base-aware (`hrefFor`) so the demo can mount under a sub-path
  ui.tsx         shared UI    store.ts settings.ts format.ts autogrow.ts clipboard.ts
  demo/          the frontend-only demo's in-browser backend (build-and-distribution
                 skill): api.ts + demo-chrome.tsx + main.css (all aliased over
                 web/src/) + backend/store/bus/agent/watchers + model/errors +
                 fixtures.gen.ts (baked seed) — no daemon, no git, all in the browser
shared/types.ts  the HTTP contract (domain model + request/response shapes)
shared/version.ts build version — /api/health reports it; the CLI warns on skew
scripts/         compile.ts (the ./r3 binary) · spa-css.ts · release-binaries.ts ·
                 stage-npm-packages.ts · build-demo.ts · stage-pages.ts ·
                 gen-demo-fixtures.ts   (build-and-distribution skill)
bunfig.toml      registers bun-plugin-tailwind so the from-source daemon bundles CSS
npm/             the published `r3` launcher (bunx/npx): resolves+execs the matching
                 per-platform binary package (`@hyperlogue/r3-<os>-<arch>`)
```

## Domain model

Three durable review entities — **Review**, **Feedback**, **Reply** — plus **Patch**,
a diff review's stored rounds, and a time-bounded **FeedbackClaim** presence lease.
**Full field shapes live in `shared/types.ts`; the SQL
schema in `server/db.ts`** — this section is the *why*, not the field list.

Feedback and Reply stay **separate**: feedback has a lifecycle/**status** + an
anchor; a reply is a **pure message** in the thread with no status of its own
(merging them would make illegal states — a "reply" that's "resolved" —
representable). Resolving is a **status toggle on the feedback**
(`PATCH /api/feedback/:id`), never a property of a reply.

- **Review** — `id`, `repo_id`, `worktree`, `title`, `summary` (a short free-form
  overview — the agent's *guide* to the review; editable via `r3 edit` only,
  read-only in the UI, rendered as Markdown with `@path:Lx-y` refs), `kind`
  (`'diff'|'files'` — the render mode), `source` (files: what to fetch; diff:
  provenance only), `meta` (free-form, **queryable** — e.g. `{ session, agent,
  branch }`; `r3 create` stamps `session` from the harness's own session id unless
  the caller passes one, so `r3 list --meta session=…` finds an agent's own
  reviews without the agent having had to remember the flag), `status`
  (`open|approved|abandoned`).
- **Patch** — one immutable stored diff round: `review_id`, `seq` (monotonic, never
  reused), `label`, `summary`, `body` (raw unified diff). Appended via `r3 diff
  add`, removed whole via `r3 diff rm` — **never edited, no hunk-level surgery**.
  Cascade-deleted with the review.
- **Feedback** — an anchored note, authored by **either side**. `author`
  (`human|agent`) is a first-class axis: the human annotates in the UI, the agent
  via `r3 feedback add` (guide the reading order, ask, flag a risk), and both get
  the same anchors, threads, and lifecycle. Agent-authored feedback is **born
  delivered** (`sent_at` = creation) so it never echoes back in the agent's own
  prompts — only the human's replies/resolution flow back; it wears an
  `[agent-authored]` label in prompt blocks (`[agent]` in `r3 show`).
  - `quote` is **the anchor of record** — the line number is only a hint. For a
    line-anchored `r3 feedback add` without `--quote`, the server derives one from
    the round/live content, **rejecting** a range that isn't fully within what the
    round/file shows (partial or hunk-gap-spanning) rather than storing a driftable
    quote-less anchor, and capping it at `MAX_QUOTE_LINES`. A whole-file or quoted
    anchor gets its path validated against the review, so no dangling note is stored.
    Conversely, when the quote **is** supplied, a files review stores the lines that
    quote actually occupies (`locateQuote`), not the sent ones — the hint is
    corrected at write time instead of waiting for the re-anchor pass, which is what
    a rendered-Markdown selection needs (below) and what a pinned/immutable source
    would otherwise never get.
  - `status` is **`open|resolved`** — two states, human-driven. Open = needs
    attention, resolved = done; the _why_ (fixed, answered, dismissed) lives in the
    thread, not the enum. The agent references feedback by its **stable `id`**
    (`feedback_<short>`), never a positional index. Resolved is **loud, not merely
    filtered**: the card takes a success wash and a `✓ resolved` pill, its Reopen
    fades back (reopening is the exception, not the next step), and the Resolved
    tab tints its own filter pill. The failure that buys is reading a resolved list
    as the working set — otherwise an empty-looking queue and a finished one are
    the same picture.
  - `patch_seq` says which round a diff review's note belongs to; a **line-anchored**
    note naming no round lands in the **latest**, while a whole-file or
    review-summary note stays round-less. `anchor` (`anchored|outdated`) carries
    staleness; `code_sha` is recorded at anchor time.
  - Two **span-less** variants: a **summary** note (`file` is the `SUMMARY_FILE`
    sentinel `@summary`; `patch_seq` names a round's summary, null = the review
    summary) and a **whole-file** note (a real path, `line_start`/`line_end`/`quote`
    all null). The automatic re-anchor pass skips both.
- **Reply** — `feedback_id`, `author`, `body`, plus an optional **pin**
  (`patch_seq`, `file`, `line_start/end`, `quote`) saying where in a later round the
  change addressing the feedback landed. Always a plain message — the human drives
  status from the UI; an `action` key from a stale client is ignored. One feedback
  can accumulate several pinned replies across rounds — the fix's history. A reply
  also carries `ref_version`, captured at post time (the latest round/snapshot, or
  null): the version its inline `@path:Lx-y` **code refs** resolve against, so a ref
  stays pointing at the code as it was written. The agent orders snapshot/round vs.
  reply to pin old-vs-new, and splits a reply in two to cite both.
- **FeedbackClaim** — an agent's explicit, feedback-scoped assertion that it is
  actively handling the item: `session`, optional `agentId`, and
  `claimed_at`/`renewed_at`/`expires_at`. It is a 60-minute renewable lease, not a
  third feedback status — `open|resolved` stays human-controlled. `r3 claim
  <feedback_id>...` creates or renews it; another live owner conflicts; a successful
  agent reply deletes that feedback's claim in the same transaction. Resolve,
  review close, delete, and expiry clear it too. Claims do not mark content
  delivered or bump `review.updated_at`; list/detail responses derive live
  `working` presence from unexpired rows and SSE keeps it current. In the active
  feedback list, claimed items rank below every unclaimed item and wear a slight
  card-wide dimming overlay; the working badge stays above that overlay at full
  emphasis. Claim tooltips name the owner/work item but deliberately omit the
  lease end time — expiry is implementation detail, not reviewer guidance.

**Message rendering.** Feedback bodies and replies are stored as **plain text** (the
contract carries raw text — edited inline, created optimistically) and rendered
**client-side** as safe Markdown (`web/src/markdown.ts`, markdown-it `html:false`).
An agent-authored `@path:Lx-y` token becomes a **click-to-scroll** ref, resolved
against the message's version (a reply's `ref_version`, or a feedback body's own
round). Humans don't type refs — selecting code while composing offers a **"Quote"**
button that drops it in as a `>` blockquote. Both summaries — the review summary
(`ReviewSummary`) and the active round's summary (`RoundSummary`, defined in
`DiffView.tsx` but mounted by `ReviewView`) — render the same way; a round-summary
ref resolves against its round, a review summary is edited in place so its refs pin
no version and resolve against the **live/current view**.

**A reviewed doc set links to itself.** A relative link in a rendered `.md`
(`[models-and-cost.md](models-and-cost.md)`) is written against the file that
contains it, but the browser resolves it against the *page* — `/review_<id>` —
so it used to open a URL that never existed. The server resolves it against the
containing file's directory and emits an `a.r3-doclink` carrying the
repo-relative target (plus a heading slug for a `#fragment`); the client jumps
the pane to that file's card instead of navigating (`web/src/doclinks.ts`).
Headings are tagged `data-r3-heading`, **not** `id` — every file renders into one
page, so two docs sharing a "## Cost" would collide; the lookup is scoped to the
target card. Only a genuinely off-repo link (a scheme, `//host`) still opens a
new tab. A target that isn't part of the review has nowhere to go, so it renders
**dead** (dimmed, with the reason on hover) rather than looking live and doing
nothing.

**A fence carries its own grammar.** A reviewed doc is mostly prose *about*
code, so a fenced block that names a language (`` ```ts ``) goes through the same
Shiki pass — and the reader's own syntax theme — the code view uses; without it
the rendered view was the one place code stopped looking like code. markdown-it
renders synchronously and Shiki tokenizes asynchronously, so `renderMarkdown`
parses once, highlights every fence token in that stream, and renders those same
tokens (no second parse, no module-level scratch state). The grammar is resolved
against Shiki's bundled ids *and* aliases, so `ts`/`sh`/`c++` need no table of
r3's own; an unknown or absent language stays escaped and unstyled rather than
guessing. A `` ```mermaid `` (or `` ```mmd ``) fence is the one exception: a
**flowchart** or **sequenceDiagram** renders to a safe inline SVG
(`server/mermaid.ts`) instead of highlighted source — mermaid.js never loads
(no DOM, no label-XSS surface, no extra SPA weight). Other diagram kinds, and
a fence we can't parse, fall through to the ordinary highlighted/plain fence.
Messages — feedback, replies, both summaries — render **client-side**
and stay unhighlighted by design: Shiki's WASM never reaches the browser.

**A token's colour is a class, not an inline style.** Every highlighted span —
code rows, diff rounds, snapshot diffs, fences — carries one short palette class
per theme slot (`<span class="sl3 sd7">`), and the colours arrive once as the
stylesheet in `ThemeStyle.css` (`GET /api/theme-style`, injected as `<style
data-r3-theme-css>`). A span is emitted only where it says something: Shiki
splits a token per textmate scope, so **adjacent tokens the palette gives the
same classes coalesce into one span**, and a run wearing the theme's **default
foreground gets no wrapper at all** — bare escaped text, painted by
`.shiki-surface`, the shape the unknown-grammar path always shipped. Nothing
downstream walks token spans (anchors come from the payload's `text`,
`mdhighlight` works in text offsets, and the row's gutter rail is a `> span` of
the row, not of `<code>`), so the element structure is free to shrink: a
repo-wide TS/TSX pass measured 146 → 112 bytes and 5.0 → 2.4 spans per line.
Pasting both colours into every span instead
(`style="--shiki-light:…;--shiki-dark:…"`) measured 425 JSON bytes per source
line on a 208-file review — 22.7 MB of blob JSON for 1.85 MB of source — and gave
every mounted span its own declaration to parse and computed style to keep. A
palette is closed (a token can only wear a colour its theme names) so it is
derivable up front; font style rides its own classes, per slot, because textmate
resolves it independently of the colour and a family's two themes can disagree.
A colour somehow outside the palette keeps the old inline form on a `.sx` span —
one span each, never merged into a neighbouring run: never lose a colour.

**The feedback dock folds to a rail, and the composer follows the gesture.** On
desktop the right-docked panel collapses (`p`, the header's fold control, or the
rail itself) to a 2rem strip, giving the content pane the width back — a persisted
global display preference (`r3-feedback-collapsed`), like the diff layout, never
review state. It is **FileBrowser's fold, mirrored**: the same `FoldChevrons`
toggle pointing the way it opens, the same uppercase vertical `<name> · <count>`
rail label, the same width transition (one box eases its width while
`overflow-hidden` clips a child already at its target width, so the panel doesn't
re-wrap frame by frame) — pinned to the far edge, so a right dock is revealed from
the outside in. Two fold affordances on the two edges of one pane would be two
things to learn for one idea; the transition stands down mid-drag, where the width
is a resize handle's live output. The panel stays **mounted**: it owns the create
mutation, the watcher query and the draft bookkeeping, so collapsing swaps its
chrome, it never unmounts anything. What survives on the rail is what you would otherwise have to
expand to learn — the open count, and one glyph for an unsaved draft / undelivered
content / live agent presence. With no list on screen to dock a composer at the
bottom of, an anchor gesture floats the *same* composer next to the code it is
about (portalled to `<body>`, clamped into the viewport, deliberately not
scroll-tracking — you are typing into it, and on its own compositing layer:
see below). Clicking a washed feedback region is
the one gesture that un-collapses the dock: it is asking to *read* that note, and
the alternative is a click that visibly does nothing. Below `md` none of this
applies — the bottom sheet's closed state already **is** collapsed, so the
preference is ignored there without being written (the forced-unified-layout
shape).

**A keystroke costs one box, not the page.** Typing is the panel's hot path, and
everything conspired against it: a portalled `position:fixed` composer paints into
the **root** layer, so each keystroke repainted every highlighted code span behind
it (~9 ms of a measured 22 ms keystroke) — hence `will-change-transform` on the
floating composer, which is the whole fix; the docked one paints inside the dock
column and needs none. Above that, three rules keep a keystroke from re-rendering
the list: **`FeedbackCard` is `memo`'d** and gets only props that survive a render
— primitives, the row TanStack structurally shares, and per-card callbacks that
take the card's id/row as an **argument** instead of closing over it, so one
function serves the whole list (a fresh arrow per card is what defeats `memo`);
the panel's **derived lists** (active/resolved/`ordered`, plus the membership keys
its effects watch) come from one `useMemo` on `detail.feedback`, since they feed
those memo'd props; and **a composer subscribes to its own draft text**, the panel
reading only the empty/non-empty flip (`useHasGeneralText`, `useHasAnchoredText`).
`web/src/autogrow.ts` closes the loop: where the browser can size a textarea
itself (`field-sizing: content`) it does, with the rows × line-height math written
once as min/max-height; the JS fit — `height:auto` then `scrollHeight`, a forced
synchronous layout per keystroke — is the fallback, not the default.

**Select-to-feedback is one gesture everywhere** — the file/diff pane, the round
summary, and the review summary all route a selection through the same
`applyAnchorGesture` (`ReviewView`): an **empty composer anchors** a note to the
selection; a **composer already holding text** raises a **"Quote in note"** bubble
instead (never clobbers). A summary selection anchors a `@summary` note by **quote**
(rendered markdown has no stable source offsets), located later via
`mdhighlight.rangeForQuote`, best-effort, falling back to flashing the whole block.

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
  appended as round 2, 3, … (`git diff … | r3 diff add <id>`); rounds are immutable
  and independent (line numbers needn't agree across rounds), the round is the unit,
  and `source` is provenance only. Capture is **wide, render is narrow**: because
  git is never consulted again, context not taken at capture can never be
  recovered, so a round is stored at `-U2000` (per-file trimmed to `-U25` above
  64 KB) and re-hunked to 3 lines at render — which is what makes **expand
  context** possible at all. Every round renders at 3 and expands **as far as its
  own stored body reaches**, whatever wrote it: a piped round (`--stdin-diff`,
  `r3 diff add`) expands up to the `-U` it was piped at, and one piped at `-U3` or
  narrower is byte-identical passthrough with no expander at all — same for a
  round stored before wide capture. Deliberately no `--context` flag: the render
  width is a display default, not per-round state. No watching, no re-anchoring, no
  staleness — the
  Gerrit-patchset shape, minus everything Gerrit needs for server-side merging.
  (`server/patches.ts`)
- A **files review** can also carry **content snapshots** — frozen full-text
  captures of every file, taken on demand (`r3 snapshot <id>`). Unlike a diff round
  (unified-diff text), a snapshot holds whole files, so the daemon can **derive an
  accurate diff between any two** (or a snapshot and live content) itself, with no
  git — which is what lets it work for scratch reviews outside any repo. The UI's
  from/to picker makes a multi-turn doc review read like a diff without leaving the
  live view; feedback stays anchored to the live file, never scoped to a snapshot.
  Snapshots are append-only + immutable; removing one orphans nothing.
- Sentinels (files reviews): `WORKING` (working tree), `SCRATCH` (adhoc content in
  the daemon's scratch dir), else any git ref/sha. `WORKING`/`SCRATCH` track live
  content ⇒ re-read + re-anchored on change; a pinned sha/ref is **immutable** ⇒
  stable anchors. `repo.isImmutableSource(source)` is the predicate; it also drives
  worktree fallback.
- **Scratch reviews**: `r3 create --scratch` makes an empty `files`/`SCRATCH` review
  + a per-review directory (path printed); the agent drops files there and the
  daemon watches the dir (flat, top-level only). The scratch dir is the _second_
  allowed `safePath` root (besides the worktree). (`server/scratch.ts`)
- `--files` takes paths **and** globs over the repo's git set (tracked + untracked,
  minus `.gitignore`d), so `**/*.ts` never pulls in `node_modules/`. It's
  **greedy** — put it last. Membership is editable later: `r3 files add|rm <id> …`.

**A files review outlives the files it lists**, so a member path that has since been
deleted or renamed is an ordinary state, not a failure: its blob 404 is cached as a
**value** — the card reads "not in the working tree", and the `file-changed`
invalidation of that same key picks the file up if it comes back — because an
errored query holds no data and therefore re-requests on every scroll past, which
on a review whose branch moved on meant hundreds of round-trips a pass (the client
also never retries a 4xx at all: the server has answered). Loaded bodies are cached
the other way round — **fresh forever, retained briefly**: SSE invalidation is what
expires them, but the query lives only while the file is near the viewport, so a
few-hundred-file review's highlighted blobs don't accumulate for as long as it
stays open. That is why `FileView` is a shell plus a body: the shell stays mounted
with the last body's sha/line-count/kind, keeping the header, the viewed key and
the fold, while the body — the blob query's only observer — comes and goes with the
preload band.

## Anchoring — keeping feedback from orphaning

**Diff reviews can't orphan by construction**: file/round feedback anchors into an
immutable stored round (`patch_seq` + quote), so nothing drifts and `reanchor` is
rejected (the review summary is the one exception, below). The response side is the
**anchored reply** — the agent pins where its fix landed in a later round (`r3 reply
… --diff <seq> …`), validated against the stored patch at post time and stable
forever.

**Summaries anchor by quote.** A `@summary` note has no worktree span, so the
automatic pass skips it and the client locates it by finding the quote in the
rendered prose (`mdhighlight.rangeForQuote`, best-effort; whole-block flash when it
can't be found). A **diff-round** summary is immutable → its quote can't drift and
`reanchor` stays rejected; the **review** summary is edited in place (`r3 edit
--summary`) → its note can drift, so it's the one `@summary` note the agent
re-points, on any review kind: `r3 reanchor <fid> --quote "<new text>"`.

**Files reviews** (`WORKING`/`SCRATCH`) **change under the review**, so keep anchors
fresh from **both sides**:

1. **Automatic (server, `anchor.ts`).** On render / file-change, search for `quote`
   near the recorded **range**, whitespace-insensitively. A markdown file is
   searched in **two projections** of the same content (`findQuoteAcross`): the
   **rendered-text projection** (`mdproject.ts` — the parsed token stream flattened
   to what the browser shows, entities decoded and markup stripped, each character
   mapped back to its source line), where a browser selection's quote matches
   *exactly* — links, tables, emphasis included — and the raw source (agent CLI
   quotes, the raw view; the only projection other file kinds have). Candidates
   rank **locality first, precision second**, across all projections per stage:
   verbatim-in-hint, fuzzy-in-hint, verbatim anywhere, fuzzy anywhere — an
   occurrence anywhere inside `line_start..line_end` counts as "at" the hint, so a
   repeated phrase resolves to the copy the note sits on, and a plain
   near-duplicate elsewhere can't outbid the marked-up copy at the note. The fuzzy
   stages are a bounded edit-distance pass (`fuzzyFind`, ≤25% edits,
   token-prefiltered and DP-capped). Found → relocate + update the range +
   `code_sha`, `anchor='anchored'`. Nothing → `anchor='outdated'`, keep the
   original quote, surface "the code this refers to changed." **Never silently
   mis-point.** **Lazy** (`server/dirty.ts`): re-anchoring re-reads files,
   so it runs only when a review is _dirty_ — the watcher marked a referenced file
   changed, or the review hasn't been anchored this daemon lifetime. An incidental
   refetch (a reply, a status flip) skips it, so an item flips to `outdated` only
   after a real content change.
2. **Explicit (agent, `PATCH /api/feedback/:id/anchor`).** When a restructure makes
   the quote un-findable, the same agent that moved the code tells the server where
   the feedback now belongs (`r3 reanchor`). It **relocates, never re-points**: the
   target is where the *quoted text* landed, not where the fix landed (that's an
   anchored reply). The **quote is immutable** here — the server keeps the stored
   one and treats the range as the new hint, rejecting a supplied `quote` that
   differs (a whole-file note, which has none, is the one that derives one from the
   range). It used to re-derive the quote from whatever range it was handed, which
   turned the mistake agents actually make — re-anchoring to where the *fix* landed
   — into a note silently re-quoting code the human never marked; now that lands as
   a wrong hint the automatic pass corrects. A quote whose text the agent rewrote or
   deleted is simply left `outdated`: visibly stale beats confidently wrong.

**Rendered Markdown has no per-line rows**, so both ends of an anchor go through
blocks: the render tags every mapped markdown-it token — nested `<li>`/`<tr>`
included, not just top-level blocks — with its source range, a browser selection
reports the **innermost** one it lands in, and the exact lines then come from
locating the quote in the source (`locateQuote` at write time, `anchor.ts` on every
pass after). The client mirrors that narrowing: it marks only innermost blocks and
highlights the located **quote** inside one (`mdhighlight`), so a note on one bullet
never washes — or swallows the clicks of — its whole list.

Across snapshot/diff views the client **locates each feedback by its quote** among
the diff rows (unchanged/added text lands on the new side, deleted on the old),
keeping feedback **singular** (one item, canonically on the live file) rather than
forking a copy per view.

## Diff rendering

Two orthogonal display choices, both **pure client render modes** — the payload,
the anchors, and every callback shape are identical either way:

- **Layout** — unified (one interleaved column) or **side-by-side** (paired
  old/new columns). One global persisted preference (`r3-diff-layout`, like font
  size), toggled from `PaneToolbar`; never review state, never sent to the server.
  Split pairs rows positionally (context with itself; a del run zipped against the
  add run following it, shorter side padded with inert filler) — deliberately not a
  re-diff, which could disagree with the line numbers anchors are keyed on. Filler
  occupies a row but owns **no text node** (`.split-filler`, a generated blank), so
  it can never enter a `quote` as a line the file doesn't have. Each half is its own
  horizontal scroll container; they stay vertically locked because `VirtualLines`
  sizes every row at a fixed height, so two instances over one row count mount
  identical windows. The phone tier **forces unified** without writing the
  preference (`mobile-tier` skill).
- **Expand context** — a hunk separator whose `expandable` counts are non-zero
  becomes an expander (`web/src/expand.ts`, `GET …/diff-context`). Availability
  rides the hunk row rather than a stored column, so the client needs to know
  nothing about capture policy and an unexpandable round reports `0` and shows the
  plain `@@` bar it always did. Revealed rows are **ordinary context rows** —
  selectable and anchorable, which is the point: without them you can't leave
  feedback on a line more than 3 lines from a change. They merge into ONE row list
  that every derived structure reads (text maps, index maps, split pairing,
  virtualizer count); deriving any of those from the unmerged payload instead would
  let a gutter drag build a quote with lines silently missing.

Anchoring in an expanded region needs no new server logic: `deriveQuote` and
`validateReplyPin` parse the full stored body, not the rendered view.

**The mounted row window moves in blocks.** Any DOM mutation inside the content
pane repaints the whole root layer, and that repaint costs the same whether the
rendered window shifted by one row or fifteen — so a scroll must not mutate the
DOM every frame, which is exactly what a per-row virtual window does (~20 ms of
main thread per frame on a 208-file review, ~70% of it paint). `VirtualLines`
therefore snaps its rendered range to **48-row blocks** — overscan folded into
the block math, so the window still reaches at least 24 rows past the viewport —
and drives `@tanstack/virtual-core` directly rather than TanStack's React
adapter, whose `onChange` hard-wires `flushSync(rerender)` on every visible-range
change. It re-renders only when the block window actually moves (a couple of
dozen rows of scrolling apart, not one), and never on a bare `isScrolling` flip;
no `flushSync` is needed because the window is already rendered past the
viewport, so landing a frame later can't expose a gap.

**A round past a size gate mounts only the blocks you can see.** A diff round
arrives as one payload, which is why it used to render every `FileBlock` eagerly
— but the payload was never the cost. A scroll pass pays a display-list walk over
the **mounted** nodes (a modest 23-file / 4123-row round mounts ~46.5k of them),
and that is the same work whether the rows arrived in one response or many. So
past `PROGRESSIVE_FILES_MIN` files **or** `PROGRESSIVE_ROWS_MIN` rendered rows a
round wraps each block in the same `ProgressiveFile` a large files review uses.
Rows, not just files: a round's usual shape is a handful of files carrying
thousands of lines, so file count alone would miss most of what hurts. What
defers is the **body** — the merged row list, the per-side text/index maps, the
split pairing, the virtualizers; the card, its header and its fold state stay
mounted, so the scroll-spy, the fold-all broadcast and the viewed toggle never
see a hole where a file should be, and a jump wakes its target through the same
`progressive.activate` registry the files path uses. Revealed expand-context is
the one thing an offscreen unmount forgets: it re-fetches, and the merge restarts
from the immutable stored body, so the rows come back consistent rather than
partial.

**A deferred block reserves the height it is going to have.** Not mounting a
body means standing something in for it, and that stand-in *is* the scroll
pane's height — which is the scrollbar. A flat placeholder (16rem, what this
started as) makes it a guess wrong in both directions at once: an order of
magnitude short on a 200-file review, and far too tall for every file big
enough to auto-fold. Worse, the guess is replaced by the truth as you scroll, so
the total climbs, the thumb shrinks, and a drag lands nowhere. So a shell takes a
`ReserveSpec` and resolves it in px (`web/src/progressive.tsx`), and two of the
three cases are **arithmetic, not estimation**: a card that will mount folded is
2rem of header, and an open code body is its row count at the same fixed line
height `VirtualLines` already assumes. Predicting the fold matters most —
precisely the files whose row count is enormous are the ones that auto-fold, so
mispredicting one is the largest error available. Rendered **markdown** is the
one genuine estimate (no row grid, and the wrapping depends on the pane's width):
it scales with the source line count via a px-per-line ratio the provider
**learns** from the cards it has measured, line-weighted because what the
reserve feeds is a total. A measurement always outranks a reserve, but only at
the font size it was taken at — the layout is rem-scaled, so a font change
retires the pixels and falls back to the reserve, which is right at any size.

Where the row count comes from differs by kind, and that asymmetry is the whole
reason this needed a route. A **diff round** already has its rows in the payload,
so `DiffView` computes its reserves inline (`splitRowCount` for the split layout —
reserving the unified count there over-reserves every rewritten run by its
shorter side). A **files review** has only paths, so `GET /api/reviews/:id/files`
reports each member file's `lines`/`kind`/`sha` — a content read per file, hence
its own route rather than a field on the detail, which is refetched on every
feedback write. `sha` is the other half of the viewed key, which is what lets the
client predict "this card mounts folded because it is already viewed" before the
blob lands.

## The review loop (the agent interface)

The human reviews in the browser, then hands feedback to the agent — either by
clicking **"Copy prompt"**, or hands-off via **`r3 watch <id>`**, which registers as
a live watcher and blocks until the human clicks **Submit** (or **`r3 listen <id>`**,
which registers and returns — below). The agent replies by
feedback id (`r3 reply <fid> -m "…"`), appends a new round or re-anchors as the kind
requires, and watches again. **`watch`'s exit code is the loop's branch signal** —
`10` submitted · `0` approved · `3` abandoned · `2` timed out · `4` already watched
— so a naive `while r3 watch; do …` is wrong. After an exit-10 hand-off, the agent
runs `r3 claim <feedback_id>...` before editing so the browser shows active work;
repeating it renews a long task, and each `r3 reply` releases its item's claim.

**A review admits one watch at a time.** Two agents blocked on the same review
don't split the round, they race it: delivery is stamped at POST time, so one can
mark the awaiting items sent between the other's read and its POST and that one
wakes with an empty prompt — and "● `<session>` watching" can only name an owner
if there is one. The slot **is** the SSE connection (`server/watchers.ts`): a
second `?session=` connect is refused `409` before the stream opens, naming the
holder, and `r3 watch` exits `4`. It takes the slot **before** draining anything
already pending, so the early exit-10 hand-off is inside the exclusion, not before
it. The one client allowed to displace the holder is **itself** — the same
`--session` + `--agent-id` — because a dropped SSE or a restarted agent must not
be locked out by its own ghost and nothing else would ever clear it; the displaced
stream is told (a stream-local `superseded` frame) and exits `4` rather than
reconnecting, which would otherwise have the two trading the slot every second.
Claims stay the *feedback*-scoped lease; this is the *review*-scoped one.

**Every session label is the harness's own session id.** One rule, two places it
lands. `create` stamps `meta.session` (above) — *who made this review*. `watch`,
`listen` and `claim` default their display identity the same way (`--session` →
`$CLAUDE_CODE_SESSION_ID` → the review's `meta.session` → `"agent"`) — *who is on
it right now*. Keeping the two distinct is the point: presence used to fall
straight through to `meta.session`, which on any multi-round loop names a
different agent than the one actually working, so the badge credited the wrong
session (and on a hand-made review, a label with nothing behind it). The three
presence commands share one chain because `watch`/`listen` reclaim the one slot
only while their session/agentId pair matches, and a claim badge beside a watch
badge should name one agent once. Everywhere a session id is *shown* it is a
**click-to-copy token** (`CopyMeta` in `ui.tsx` — the review header's metadata
line and the panel's presence badges) displaying a UUID's first group, like a
short sha: it is the handle you paste into `r3 list --meta session=…`, an agent
list, or a message to that session, and a truncated one you can only re-type is no
handle at all.

**`r3 listen` is the same slot without the process.** `watch` costs the agent a
held process per round, which is the whole cost on a harness that can't hand a
background process's completion back. Where the harness exposes a **session
inbox** — Claude Code binds a per-session Unix socket and documents it as a place
for a script to post into a session, and is **the only harness supported today** —
`r3 listen <id>` registers that inbox and returns; the daemon writes a one-line nudge on Submit, approve and abandon
(`server/inbox.ts`). The nudge deliberately carries **no feedback content**: the
delivery stamp stays where it was, on `POST …/prompt`, so a dropped frame costs a
round-trip instead of eating a round. It carries the review id and a timestamp because the harness drops
*identical* repeats arriving close together — the id separates two reviews, the
timestamp separates two Submits on the same one, which is the case that would
otherwise leave a round unsent with nothing to report it.

The two kinds share the one slot, and `kind` is **not** part of client identity —
an agent switching `watch`→`listen` mid-loop is reclaiming its own slot, not
racing for it. What differs is how a dead holder is noticed: a `watch` holder is
live by construction (the connection *is* the slot, so a dead one has already
released), while a `listen` holder is only a record. So admission **probes** a
listener — and only a listener — or a dead session's registration would refuse
every `r3 watch` until someone hit Submit.

The wire is **fire-and-forget with no ack**, and r3 sends no reply address (a
valid one must be a socket in the harness's own namespace, and r3 could only
supply that by squatting it — which would make the daemon show up as a session in
the harness's agent list). Measured consequence: r3 cannot be told its message was
held, so the **connect is the only liveness signal there is**. That is why Submit
awaits the write and answers `502` on failure, dropping the registration so the UI
falls back to Copy prompt.

It is also why the session's messaging **token is required, not best-effort**.
Without an auth line the harness attributes a push by descent, and whether the
daemon descends from the session is an accident of which session's first CLI call
happened to spawn it — one per-user daemon spans every session but can be the
child of at most one. A push from a non-descendant is **held for approval**
(measured), and with no reply address r3 never learns that it was: the write
completes, Submit answers 200, and the agent is never woken. So a tokenless
registration is a coin flip resolved silently, and `r3 listen` refuses one up
front with the same **exit 5** it gives a harness that has no inbox at all —
"can't be messaged, fall back to `r3 watch`" is one answer, not two.

The other half is measured as well: the same non-descendant daemon (reparented to
init) pushing **with** the auth line is delivered under the default inbound
policy. Attribution is what the harness gates on, not descent — which is what
makes a mandatory token a complete answer rather than a mitigation. Silent non-delivery is the one failure `watch`
structurally cannot have, and the one worth a round-trip to avoid. The registry is
in-memory (it holds a live session credential — see the **`security-model`**
skill), so a daemon restart drops every registration; that matches what `r3
restart` already does to in-flight watches, and Submit's loud failure is what
surfaces it.

Delivery is tracked (`sent_at` + `status_unsent`), so a prompt is **unsent-only**
and even a bare Resolve/Reopen click reaches the agent as "`[resolved]` — no action
needed". Editing a delivered human reply or an open note's body clears that row's
`sent_at` so the correction re-enters the next prompt. The predicate lives once in
`shared/types.ts` (`hasUnsentContent`) and the server, CLI, and web all call it.

**Approve is gated on work in flight, not on open feedback.** The UI blocks the
terminal action while something would be *lost or interrupted* by it — content
the agent has never read, or an item under a live `feedback_claims` lease (a
reply is still landing). An open note you read and chose not to chase blocks
nothing: approving is the human's call, and "resolved" is a decision, not a
chore. **Unread is narrower than undelivered**: the gate starts from
`hasUnsentContent` but drops a *resolved* item whose only undelivered thing is
its own status flip — handing the agent "this is resolved" is what approving is
about to say at review scope, so requiring a Submit round-trip first is a loop
carrying no content. Prose still blocks (a human reply written since the last
hand-off), and delivery is untouched: the flip stays unsent, so Submit and the
next prompt carry it as before. Both blockers clear on their own, so the button
is never stuck. The server and CLI enforce no gate at all — `PATCH
/api/reviews/:id` approves whatever it's asked to — so this is a guardrail on
the one click that ends the loop, not a rule.

**Full protocol, delivery rules, and every command → the `api-surface` skill;
`r3 guide` prints the agent-facing version.**

## Storage & data files

All under XDG, keyed by `server/config.ts`:

- `$XDG_STATE_HOME/r3/r3.sqlite` — the one global store (reviews + feedback +
  replies + renewable `feedback_claims` + per-reviewer `viewed_marks` + the `repos` registry + the quick-auth
  `auth_tokens` / `auth_sessions`, both hashed at rest).
- `$XDG_STATE_HOME/r3/token` (mode 0600) — the per-user API token, handed to the
  same-origin page by `/api/boot` (only while `REQUIRE_LOGIN` is off), read from
  `daemon.json` by the CLI. Distinct from the user-created **login tokens**.
- `$XDG_STATE_HOME/r3/scratch/<review_id>/` — scratch reviews' file directories
  (legacy single-file docs live as `scratch/<review_id>.md`). Diff rounds live in
  the sqlite `patches` table, not on disk.
- `$XDG_CONFIG_HOME/r3/config.json` — the **persisted exposure config**
  (`{ bind?, port?, publicUrl?, allowedHosts?, requireLogin? }`, only set keys,
  **no secrets**), written by `r3 config set` and read at startup **below env**
  (`env ?? config.json ?? default`). Hand-editable; absent/malformed is tolerated.
- `$XDG_RUNTIME_DIR/r3/daemon.json` (fallback state dir, mode 0600) — `{ url, port,
  pid, token, version, exec, argv, publicUrl, requireLogin }`; the CLI's discovery
  record. `exec`/`argv` are the serving process's own `process.execPath` /
  `process.argv`; `publicUrl`/`requireLogin` are the posture it resolved at startup
  — all surfaced by `r3 status`.
- `$XDG_RUNTIME_DIR/r3/daemon.lock` — O_EXCL start-lock (Bun defaults SO_REUSEPORT
  on, so the port is _not_ a lock); colocated with `daemon.json` so a reboot drops
  both. A stale lock (dead pid) is stolen on next start.

**A daemon that is alive but no longer serving is `r3 stop`'s problem, not the
lock's.** `acquireDaemonLock` is sync and can't probe, so liveness is all it has:
a wedged owner (deadlocked event loop) reads as "held", every spawn steps aside,
and `r3 start` fails forever. So `stop` never infers "unhealthy ⇒ crashed" — it
identifies the process (`__daemon` in its command line, or daemon.json's recorded
`exec`) and **kills it**, SIGTERM escalating to SIGKILL, because a wedged daemon
can't run its own JS signal handler. Clearing `daemon.json` and walking away —
what it used to do — is the one move that makes the state unrecoverable: the
process keeps the port and the lock with nothing left naming it. For the same
reason `stop` falls back to the **lock** when `daemon.json` is already gone (the
lock is the second record of who is serving), and a spawn that times out reports
the blocking pid instead of a bare timeout.

`process-compose.yaml` points all three XDG dirs at `workspace/` and uses port 8891,
so the dev stack never collides with — or writes into — a normally-running daemon.

Dev/test overrides, on top of the exposure knobs: `R3_DB` (store path), `R3_TOKEN`
(per-user token), `R3_NO_WATCH` (skip the file watcher), `R3_DETACHED` (ignore
SIGINT), `R3_DEV` (HMR), `R3_URL` (point the CLI at a specific daemon).

## Viewed-state (per-reviewer read progress)

The GitHub-PR-style "Viewed" fold marker is **server-persisted** in `viewed_marks` —
r3 is single-user, so "have I read this?" is legitimate review state that should
follow you across browsers/devices. The row `key` encodes **content identity**, not
a path: a diff round's file is keyed `d:<seq>:<path>` (immutable rounds ⇒ naturally
per-round), a live files-review file `f:<path>@<sha>` (a changed file gets a new sha
⇒ its old mark stops matching ⇒ the card auto-unfolds). `ON DELETE CASCADE` drops
the marks with the review — no cap/LRU/cleanup. Two token-gated routes (`GET/PUT
…/viewed`; the PUT is same-origin too, like any write), no SSE, no CLI — a pure UI
affordance that does **not** bump `review.updated_at` (`web/src/viewed.ts` writes
optimistically so the fold is instant).

## Keyboard shortcuts

**One rule decides the whole map: a shortcut fires a control that already exists
on screen.** No binding invents a capability, a mode, or review state — it is a
keystroke for a button you could have clicked, under that button's own `disabled`
condition. That is what keeps the list short enough to hold in your head, keeps
`web/src/keys.ts` free of behaviour, and makes "should this be bound?" answerable:
if there's no control behind it, no.

**Anchoring a line range stays mouse-only.** A keyboard selection would need a
line cursor kept alive through virtualization, a visual mode, and an operator
grammar — the bulk of the cost for a fraction of the loop. Reading, navigating,
replying, resolving and handing off are all keyboard-driven; marking the spot is a
drag. Consistently: no in-pane search, no expand-context binding (it needs a
target hunk, and with no cursor there isn't one), and no `Enter` binding anywhere
(a focused button already activates on Enter natively).

- **`KEYMAP` is the single source** for both the dispatcher and the `?` overlay
  (`ShortcutsOverlay` renders straight off it), so the help can't drift from the
  behaviour — the `hasUnsentContent` pattern.
- **Handlers register per-component** (`useKeyBindings`): whoever owns the state
  owns the binding — `FeedbackPanel` the Review + Feedback groups, `ReviewView`
  the Files + View groups, `JumpToFile` its own opener. Nothing is lifted or
  drilled to serve a keystroke. A handler left `undefined` is simply unbound, so a
  key that doesn't apply to the view on screen does nothing — and its row in the
  `?` sheet renders dimmed (`isBound`), so "nothing happened" reads as unavailable
  rather than broken. **Mounted-but-hidden counts as not on screen**: below `md`
  the panel lives in a closed, `inert` sheet, so `ReviewView` passes
  `keysActive={!isMobile || sheet !== "closed"}` and its group unbinds there.
- **The two "cursors" already existed**: `activePath` (the scroll-spy's current
  file) and `activeFbId` (the focused feedback). Every per-file and per-feedback
  binding targets one of them, which is why this needed no new review state.
  `activePath` is marked on the file's own header (`FileCard current`) with an
  accent rail and nothing else — `z`/`x`/`a` mutate, so the target can't be
  implicit, but one of these is on screen at all times, so it has to stay quiet.
  The spy also re-measures on a version switch, so the target is never a file the
  pane dropped.
- **"Current file" = the first block still showing, unless it's nearly gone.** It
  hands over to the next block once the top one is down to `ACTIVE_HANDOFF_SHARE`
  (15%) of the pane — you're already reading its successor by then, and the old
  crossed-a-scanline test only handed over when the next file *reached the top*,
  a full screen later. Two clauses keep the marker reachable, which matters
  because `]`/`[` index on it: a block that is **wholly visible** never hands off
  (a folded file is one 2rem header and could never clear 15%, so a bare share
  test would skip every folded file), and at the **end of the scroll** the last
  block wins outright (a final file shorter than ~85% of the pane could otherwise
  never win, and `]` would stick on its predecessor) — but only when there **is**
  something to scroll, since a pane whose content fits is at its end from the
  first frame and nothing has been scrolled past. The test runs over the blocks
  the pane is **currently showing** and no others: an `IntersectionObserver`
  rooted on the pane keeps that set, so a frame measures one or two boxes
  instead of one per file. It narrows the candidates, never the rule — the same
  rect tests still decide — and what it buys is a 200-file review no longer
  spending most of a scroll asking files far above the viewport for geometry.
- **The spy re-measures on resize, not just on scroll.** Most of the pane's
  content arrives after the effect attaches and fires no scroll event — a files
  review paints one small `[data-file]` stub per file until its blob lands — so a
  `ResizeObserver` on the pane and on its content watches for that (and for the
  fold/unfold restack, and for the feedback-panel drag, which changes the 15%
  denominator). Without it the marker keeps whatever it computed against stubs,
  which is how it once opened a review with no file marked at all. That signal is
  also when the block list is re-scanned and the observer re-pointed — the list is
  held, not re-queried per frame — so a version switch or a late card joins it.
- **Collapsing the dock takes its keys with it.** `p` folds the desktop feedback
  panel to its rail and back — its control (the header's `›`, then the rail
  itself) is on screen in both states, which is what makes it bindable at all.
  While it is folded the panel's own Review + Feedback groups unbind, exactly as
  they do inside the phone's closed sheet: one rule, a second way of being off
  screen. `p` itself is unbound below `md`, where the sheet is the panel and there
  is no collapse control to fire.
- One flat map, no modes, no prefixes, no counts. The layer stands down whenever
  focus is in a text field, and everything but `?` stands down while the overlay
  is up (`suspendKeys`; `keysSuspended()` lets the composer's own `Esc` listener
  stand down with it, so one press doesn't both close the sheet and discard the
  composer behind it). `Esc` is deliberately NOT in the map — it stays owned by
  whatever popup or composer is open.
- **`Space`/`Tab` are composer-owned too, for the same reason** — KEYMAP binds only
  letters and punctuation so a focused control keeps its own `Space`/`Enter`. The
  one composer that opens **unfocused** (a selection/gutter/summary anchor, where
  autofocus would collapse the selection you just made) takes `Space` and forward
  `Tab` as a jump into its textarea, so the note is one keystroke away without
  reaching back for the mouse. It stands down for a **keyboard-focused** target
  (`isKeyboardFocused` = `:focus-visible`), not for every interactive one: focus
  stranded on a *clicked* pane button shows no ring and would otherwise eat the
  `Space` by re-firing that button, while a control you actually tabbed to keeps
  both keys — which is what keeps the focus ring usable.
- **OS key repeat is opt-in** (`Binding.repeatable`, only the four next/prev
  bindings). Most of this map mutates and repeat fires ~30×/s: a leaned-on `e`
  would walk the list resolving every open item, since each resolve advances focus
  to the next card. A non-repeatable chord is still swallowed, just not re-fired.
- `Ctrl-n`/`Ctrl-p` ship as **aliases** only: `Ctrl-n` is a reserved browser
  shortcut on Windows/Linux that page JS cannot cancel. `j`/`k` are the documented
  primary and behave identically everywhere.
- Keys that belong to ONE focused widget stay out of KEYMAP and live on that
  widget: the jump-to-file picker's ↑/↓ (`Ctrl-p`/`Ctrl-n`) cursor and `Enter`
  ride its filter input, which is exactly where the global layer has already stood
  down. Putting them in the map would mean tracking "is the picker open" globally
  to stop `j` doing two things at once.

## Deep reference

Four areas are large enough to own their own file. Each is the **design source of
truth** for its area — update it there, not here — and loads on demand as a skill:

| Skill | Owns | Reach for it when |
| --- | --- | --- |
| **`api-surface`** | the `/api` route catalog, the CLI usage block, the watch/submit protocol + exit codes, delivery tracking | adding/changing a route or command, wiring a client, keeping types+server+CLI+web in sync |
| **`security-model`** | Host guard, token/cookie auth, same-origin rules, quick-auth + `REQUIRE_LOGIN` derivation, remote access, input guards, dependency cooldown | touching `auth.ts`, `config.ts`, route guards, exposure/`R3_*`/`config.json`, or reviewing for security impact |
| **`mobile-tier`** | everything below `md` (768px): `web/src/mobile/`, the sheet, sticky mechanics, touch anchoring, ergonomics | any change that renders on a phone, or touching `max-md:`/`pointer-coarse:` |
| **`build-and-distribution`** | the `--compile` binary + CSS pre-pass, GitHub/npm channels, the browser demo + Pages, nix | touching `scripts/`, `npm/`, `web/demo/`, `bunfig.toml`, the nix build, or a broken build |

Cutting an actual release (changelog, version bump, tag) is the separate
**`release`** skill.

## Dev commands

```sh
bun install                 # deps (direnv runs this automatically via .envrc)
bun run dev                 # daemon with --watch + Bun HMR (R3_DEV=1 bun --watch server/index.ts)
process-compose up          # the dev daemon, isolated to workspace/ on port 8891
bun cli/index.ts <cmd>      # drive the CLI against the running daemon (lazily spawns one)
bun run storybook           # component workshop on :6007 (process-compose up storybook)
bun run build               # Bun.build --compile -> single ./r3 binary (embeds the SPA)
bun run gen:demo            # re-bake the demo seed fixtures (only after editing canned content)
bun run build:demo          # Bun.build the frontend-only demo -> dist/demo
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
  `bun-plugin-tailwind` for the static SPA bundle — from the cwd, so a daemon lazily
  spawned in some other repo wouldn't find it and the SPA's `@import "tailwindcss"`
  would fail to bundle (blank page). Purely a build concern — the daemon is
  repo-agnostic, so cwd carries no product meaning. The bounded cwd is also what
  makes HMR safe on a lazily-spawned daemon (the watcher can't crawl an arbitrary
  huge repo and exhaust fds). The compiled binary embeds the SPA, so its cwd is
  irrelevant — it inherits the CLI's.

## Checks

Before committing, run:

```sh
bun run typecheck           # tsc --noEmit across server + cli + web + shared + scripts
bun test                    # the targeted tests (bun:test, `*.test.ts`)
biome check .               # lint + format (biome is in the nix shell, not a devDep)
biome check --write .       # apply fixes
```

**Tests are targeted, not a suite.** There is no coverage goal and most of the
server has no test at all — a review tool's behaviour lives in git, sqlite, and
the browser, where a type checker and a story catch more per minute than a mock
would. What earns a test is a **rule with states and a clock**: cheap to state,
expensive to get wrong at runtime, and invisible to `tsc`. The claim lease is the
worked example (`server/claims.test.ts`) — who may renew, what a reply releases,
when expiry stops counting; the watch slot is the other
(`server/watchers.test.ts`) — who is refused, who may take the slot back, whose
late cleanup must not free it. A pure client helper can earn one on the same
terms: `web/src/resolveFeedback.test.ts` pins where a quote lands in a derived
diff (which side, which lines, across a hunk gap) — a placement nothing
type-checks and nothing fails loudly on. A server test **must** point `R3_DB` at
its own temp store and `await import()` the modules under test, because
`server/db.ts` opens its singleton at import time; a static import would open
the real `$XDG_STATE_HOME/r3/r3.sqlite` before the env var lands.

Components have **Storybook stories** (`*.stories.tsx`) as the visual test surface —
add/update a story when you change a component. Config lives in `biome.jsonc`
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
- **Never weaken the security posture.** r3 binds `127.0.0.1`; every `/api` endpoint
  is Host-gated and needs the token or a session cookie; mutations are additionally
  same-origin. **Never bind `0.0.0.0`**, and never move a data/token endpoint out
  from behind the guard. Details + rationale: the **`security-model`** skill.
- **Anchoring is quote-first** (the line number is a hint) — preserve the
  automatic-relocate + explicit-reanchor behavior when touching `anchor.ts` /
  render / watch.
- **Diff rounds are immutable** — never add an edit-a-patch path; changes arrive as
  new rounds, and feedback/reply pins into a stored round must stay valid forever
  (that's what makes them trustworthy).
- **Mobile must not complicate desktop** — mobile UI lives in `web/src/mobile/`,
  desktop never imports from it, and existing components take only inert `max-md:` /
  `pointer-coarse:` tweaks. Details: the **`mobile-tier`** skill.
- **This file + its four skills are the design source of truth** — update the one
  that owns the area when a design decision changes.
- **Keep `r3 guide` accurate** — the `GUIDE` text in `cli/index.ts` is the
  agent-facing orientation that sibling repos defer to instead of duplicating, so a
  stale guide silently mis-instructs every agent in every repo. Any commit that
  changes the CLI's public interface — a command, a flag, output shape, or the
  review-loop protocol — must re-check `GUIDE` (and `HELP`) in the same commit.
