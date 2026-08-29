---
name: api-surface
description: r3's full HTTP/JSON route catalog and CLI command reference — every /api endpoint with its shape and gating, the r3 CLI usage block, the watch/submit review loop with its exit codes, and the delivery-tracking (sent_at / status_unsent) rules. Use when adding, renaming, or changing an HTTP route or CLI command/flag, wiring the CLI or web client to the server, checking what an endpoint returns, or keeping shared/types.ts + server + CLI + web in sync.
---

# r3's API + CLI surface

This file is the **design source of truth** for r3's route catalog and CLI usage —
update it here when the surface changes. The wire *shapes* live in
`shared/types.ts` (the contract itself); this is the map over them.

**The HTTP/JSON API is the product**, not a detail of the React client — there are
three clients (browser, CLI, agent). When you change behavior, change
`shared/types.ts` and keep server + CLI + web in sync.

## HTTP API

Routes are served by `server/index.ts` behind the Host + token guards (see the
**security-model** skill). **Highlighting runs server-side** — Shiki for code,
markdown-it for `.md` (with per-block source-line mapping for anchoring; a
`` ```mermaid `` flowchart/sequenceDiagram fence becomes a safe SVG) — shipping
tokens to the client cached by content sha, so the WASM/grammar weight never
reaches the browser.

**Browse (read)**
`GET /api/git/status | /api/git/log | /api/git/tree | /api/diff | /api/blob` —
status, paged commit history, file tree at a ref, a structured highlighted diff,
one rendered file.

**Reviews**
- `GET /api/reviews` — list, queryable by `session` / `meta.<k>` / `status` /
  `repo`; each row carries a live `watching` flag.
- `POST /api/reviews` — create `{ kind, source, meta, title, summary }` →
  `{ id, url, review }`. `scratch:true` creates a scratch review and the response
  adds the `scratchDir` path the agent drops files into; `patch:'<diff>'` stores a
  piped diff as round 1.
- `GET /api/reviews/:id` — review + feedback[] (with replies[]) + round and
  snapshot metas.
- `GET …/diff[?seq=]` — a diff review's rendered rounds. `?seq=` returns that one
  round (`{ rounds: [that] }` or `{ rounds: [] }` if missing); omitted returns
  every stored round (compat). A legacy review with no stored patches renders live
  as seq 0 (`?seq=0` or omitted). Rounds are stored wide and rendered at 3 context
  lines; each hunk row carries `expandable {up,down}` saying how many unchanged
  lines the server still HOLDS: `up` = the gap above that hunk, `down` = the gap
  below, set on the last hunk of each **contiguous run** (a body has several runs
  when capture itself had gaps). All-zero/absent = nothing more exists, and the
  client shows no expander.
- `GET …/diff-context?file=&start=&end=&(seq= | from=&to=)[&theme=]` →
  `{ file, lines }` — fill one collapsed gap. `[start,end]` are **NEW-side** line
  numbers, capped at 5000 rows. `seq` selects a diff review's stored round;
  `from`/`to` a files review's snapshot diff — branch on **which params are
  present, never on a seq value**, since the snapshot diff is presented as
  synthetic round 0 and would collide with the legacy live-render round 0. A range
  the source can't fully cover is a **404, never a partial fill**.
- `GET/POST/DELETE …/patches[/:seq]` — list / append / drop a round.
- `POST …/files` — membership `{ add?, remove? }`.
- `GET/POST/DELETE …/snapshots[/:seq]`, `…/snapshot-diff`, `…/snapshot-blob` —
  content snapshots and their derived diffs.
- `PATCH /api/reviews/:id` — edit `{ status?, meta?, title?, summary?, note? }`
  (`note` → `meta.next_steps`); `DELETE /api/reviews/:id`.

**Hand-off** — note which verb marks:
- `GET …/prompt[?scope=unsent][&feedback=]` — the `text/plain` prompt, marking
  **nothing**. Default = full history of open items; `scope=unsent` previews the
  hand-off text, which is how the web copies first and marks only on success.
- `POST …/prompt { feedback? }` — the unsent-only hand-off, and **the one that
  stamps `sent_at`**. Rendering and stamping are one step, so the response carries
  `x-r3-prompt-items: <n>` — how many feedback items the body holds. That is the
  only reliable way to tell an empty drain from a real hand-off: the body is prose
  the human partly wrote, so matching it against the "(no unsent feedback …)"
  sentence lets a note quoting that sentence swallow a round already marked sent.
- `GET …/watchers` + `POST …/submit` — live `watch` clients (0 or 1: a review
  admits one watch at a time) / fire a `submitted` event.

**Feedback + replies**
`POST /api/reviews/:id/feedback` (on a **files** review a supplied `quote` wins over
the sent line range: the server stores the lines that quote actually occupies,
keeping the hint only when it can't find it) · `PATCH /api/feedback/:id` ·
`PATCH /api/feedback/:id/anchor` (re-anchor a files-review file anchor: the stored
`quote` is kept and the lines are only its new hint, so a differing `quote` is
**400** rather than applied, and only a whole-file note — which has none — derives
one from the range. A review-summary note re-anchors by `quote` on any kind, the
quote being the whole anchor; diff file/round anchors and round summaries are
immutable, else 400) · `DELETE /api/feedback/:id` ·
`POST /api/feedback/:id/replies` (optional pin, validated against the stored round)
· `PATCH /api/replies/:id` (edit the last human message; web-only, no CLI).

**Repos + themes**
`GET /api/repos` · `PATCH /api/repos/:id` (rename) · `POST /api/repos/:id/relink` ·
`DELETE /api/repos/:id` (forget) — the registry behind `r3 repo …` and the browser's
repo selector. `GET /api/themes` + `GET /api/theme-style[?theme=]` — the highlight
themes the SPA can pick from, and the selected one's surface colours **plus `css`,
its palette stylesheet**. That stylesheet is where every rendered token's colour
comes from: highlighted HTML carries only palette classes (`<span class="sl3 sd7">`,
light slot / dark slot), never the two inline custom properties per span it used to
(measured 12x the source size in blob JSON). Both sides are per-theme and must
match — a client passes the same `?theme=` to the content routes and to this one,
and injects `css` once (`<style data-r3-theme-css>`), replacing it on a theme
change. Blank `css` ⇒ no palette; those lines carry `.sx` inline-style spans that
the SPA's own CSS colours.

**Live**
`GET /api/events?review=:id[&session=&agentId=]` — SSE (`review-updated`,
`feedback-updated`, `file-changed`, `watchers-changed`, `submitted`,
`reviews-changed`); a connection with `session` registers as a watcher. **The
connection is the review's one watch slot**: a `session` connect on a review
another client already holds is refused **`409 WatchRefusedResponse`** (naming the
holder) *before* the stream opens; the same `session`+`agentId` reconnecting is
admitted and evicts its own ghost, which gets a stream-local `superseded` frame
(`SUPERSEDED_EVENT`, not a broadcast) and closes. Browser tabs pass no `session`,
are never watchers, and are never refused.
`GET/PUT …/viewed` — per-reviewer read progress (no SSE, no CLI).

**Auth (quick-auth)** — see the **security-model** skill for the policy behind these.
`GET /api/boot` bootstraps the SPA: with `REQUIRE_LOGIN` off it returns the per-user
`token`; with it on it needs a login-token session and answers `401 { needsAuth }`
otherwise. `POST /api/auth/login { token }` trades a login token for an HttpOnly
cookie; `POST /api/auth/logout` ends it. `GET/POST /api/auth/tokens` +
`DELETE /api/auth/tokens[/:id]` list / mint / revoke (one or all) — shared by
`r3 auth …` and the settings UI.

## CLI surface

`cli/index.ts` is the binary and the agent's entry point. It discovers the daemon
via `$XDG_RUNTIME_DIR/r3/daemon.json` (or `R3_URL`), and every **review** command is
one HTTP call — `start|stop|status|restart`, `config`, and `guide` are handled
locally, before `ensureServer()`.

```
r3 create --commit <sha> | --diff <base>..<head> | --working | --staged
          | --stdin-diff [--label L] | --scratch   [--title T] [--summary S] [--meta k=v]...
r3 create [--ref <ref>] [--title T] [--summary S] [--meta k=v]... --files <path|glob>...
                                                   # --files is GREEDY — every flag goes before it
r3 list   [--meta k=v]... [--status open]
r3 show   <id> [--json]
r3 prompt <id> [--all] [--feedback <fid,...>]      # --all: re-print all open items, mark nothing
r3 watch  <id> [--session <name>] [--agent-id <id>] [--auto-fetch-timeout <sec>] [--timeout <sec>]
r3 diff   add <id> [--label L] [--summary S] | list <id> [--json] | rm <id> <seq>
r3 files  add <id> <path|glob>... | rm <id> <path>...
r3 snapshot <id> [--label L] | snapshot list <id> [--json] | snapshot rm <id> <seq>
r3 reply  <feedback_id> -m "<msg>" [--diff <seq> --file <f> --line <a-b> [--quote "<text>"]]
r3 feedback add <id> -m "<msg>" [--file <f> [--line <a-b>] [--quote "<t>"] [--side old|new]]
            [--diff <seq>]                      # agent-authored feedback
r3 reanchor <feedback_id> --file <f> --line <a-b>                      # files-review anchor
r3 reanchor <feedback_id> --quote "<new text>" [--line <a-b>]          # review summary (any kind)
r3 edit   <id> [--title "<t>"] [--summary "<s>"]   # "" clears; --summary - = stdin
r3 approve <id> [--note|-m "<next steps>"] | abandon <id>      # --note - = stdin
r3 auth create-token [--label L] | list-tokens [--json] | revoke-token <id> | --all
r3 config show | get <name> | set <name> <value> | unset <name>
r3 guide                                            # print the agent orientation text
r3 start | stop | status | restart                 # per-user daemon lifecycle
r3 repo list | repo relink <repo-id> <path> | forget <repo-id>
```

`r3 auth` manages the login tokens that open the web UI when the daemon is exposed
beyond loopback; a loopback-only daemon needs none. `create-token` prints the token
once (hashed at rest).

`r3 config` is a **flat key→value store** whose names are exactly the JSON fields
`config show` prints — `bind | port | publicUrl | allowedHosts | requireLogin`
(`allowedHosts` is a comma list). It's a pure file op (never touches the running
daemon); settings are read **below env** (`env ?? config.json ?? default`) and take
effect on the next `r3 restart`. It writes no secret.

`--meta session=<id>` ties a review to a session; `list --meta session=<id>` lets an
agent find its own reviews.

## The review loop

`r3 guide` prints this flow as agent-facing orientation text (the `GUIDE` constant
in `cli/index.ts`). **External repos defer to `r3 guide`, so it must stay truthful**
— any commit changing a command, flag, output shape, or the protocol must re-check
`GUIDE` **and** `HELP` in the same commit.

Two hand-off paths:

- **Copy prompt** (manual) — the human clicks "Copy prompt" and pastes it.
- **Watch + Submit** (hands-off) — the agent runs `r3 watch <id>`, which registers
  as a live watcher (`server/watchers.ts`) and **blocks**. The panel adapts: with a
  watcher it shows "Submit" + a "● `<session>` watching" indicator instead of "Copy
  prompt". The human clicks Submit, the server broadcasts `submitted`, and `watch`
  prints the prompt and exits.
  **One watch per review.** Two watchers don't share a review, they race it:
  delivery is stamped at POST time, so one can mark the awaiting ids sent between
  the other's read and its POST and that one exits 10 with an empty prompt
  (r3-9fc). `watch` therefore takes the slot **before** it drains anything
  pending, and a refusal is exit `4`. The exception is the same client
  reconnecting (identical `--session` + `--agent-id`): it takes its own slot back,
  since a dropped SSE or a restarted agent must not be locked out by its own
  ghost, and the displaced process exits `4` too rather than reconnecting into a
  fight over the slot.

The agent then **replies by feedback id** — always a plain reply saying what it
changed / why it disagrees / a follow-up (`r3 reply <fid> -m "…"`); the human drives
status from the UI. The follow-up move differs by kind:

- **diff review** — append fixes as a new round, then pin each reply to where the
  change landed: `git diff … | r3 diff add <id> --label "round 2"`, then `r3 reply
  <fid> -m "…" --diff <seq> --file <f> --line <a-b>`. The UI shows "↳ addressed in
  diff N" with a jump.
- **files review** — if an edit **moves** the text a feedback quotes, **re-anchor**
  the note to where that text landed (`r3 reanchor <fid> --file <f> --line <a-b>`;
  the stored quote is kept; the lines are just the new hint). Never re-anchor to
  where the *fix* landed — that's the reply — and never onto different text: a
  quote the agent rewrote or deleted stays `outdated`.

**Feedback flows both ways.** The agent can open items too (`r3 feedback add`) — to
guide the human through a big review, ask a question, or flag a risk. They appear
live wearing an "agent" chip and rank into the human's attention zone. This is a
*usage pattern*, not a protocol change.

### Exit codes — the loop's branch signal

`r3 watch` exits: **`10`** = feedback submitted (act on it, watch again) · **`0`** =
approved (terminal success; the human's optional "next steps" note prints to
stdout) · **`3`** = abandoned · **`2`** = timed out · **`4`** = another watch holds
this review (refused, or superseded by a newer watch of the same session) — stop,
don't retry. A naive `while r3 watch; do …` is **wrong** — branch on `$?`. Ending
the loop is the human's move (`r3 approve` / `r3 abandon`, or the UI buttons).

`watch` also returns immediately if feedback is already pending. `--timeout <sec>`
(default 0 = never) bounds the wait; `--auto-fetch-timeout <sec>` opts into
auto-send after N idle seconds when no human will click Submit. `--session` is the
UI display name; `--agent-id` a precise machine handle other tools read from
`GET /api/reviews/:id/watchers`.

## Delivery tracking

Tracked with `sent_at` + `status_unsent`. Every hand-off marks the feedback + human
replies it renders sent, so a prompt is **unsent-only**: new feedback in full, plus
a compact `(follow-up)` block for any feedback that gained a human reply since.
Agent replies never re-appear — the agent wrote them.

**The decision itself is deliverable.** A bare Resolve/Reopen click posts no reply,
so a status flip **of a delivered item** raises `status_unsent`, and the next prompt
reports "`[resolved]` — no action needed" (then clears the flag). An undelivered
item owes nothing extra: an open one delivers in full with its current status, and a
note resolved before any hand-off is settled without the agent ever seeing it.

Copy/Submit disable once nothing is unsent (a fresh reply or decision re-enables
them). Editing a delivered human reply (`PATCH /api/replies/:id`) or an open
note's body (`PATCH /api/feedback/:id`) clears that row's `sent_at`, so the
correction is unsent again — otherwise `hasUnsentContent` would skip it and the
agent would keep acting on the old wording. Agent-authored replies stay stamped
(the agent wrote them); a same-body no-op does not clear. `r3 show <id>` re-prints
the full history without marking; `r3 prompt <id> --all` re-prints every **open**
item without marking. A restarted `watch` won't re-emit what was already delivered.

The unsent predicate lives once in `shared/types.ts` (`hasUnsentContent`) — the
server's prompt, the CLI's `watch`/`prompt`, and the web's Copy/Submit gate all call
the same function.
