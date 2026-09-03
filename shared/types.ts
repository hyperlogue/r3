// Domain model + HTTP/JSON contract (server, CLI, SPA).

export type ReviewKind = "diff" | "files";
export type ReviewStatus = "open" | "approved" | "abandoned";
// Runtime twin of ReviewStatus. A review's status is a state machine `r3 watch`
// branches its exit code on, so an unrecognized value doesn't just look wrong —
// it makes the loop take the "abandoned" branch and stops the watcher tracking
// the review's files. Validate it at the edge rather than trusting the cast.
export const REVIEW_STATUSES = ["open", "approved", "abandoned"] as const;
export const isReviewStatus = (v: unknown): v is ReviewStatus =>
  typeof v === "string" && (REVIEW_STATUSES as readonly string[]).includes(v);
// Human-driven; resolving is a status toggle, not a kind of reply.
export type FeedbackStatus = "open" | "resolved";
export type AnchorState = "anchored" | "outdated";
export type DiffSide = "old" | "new";
export type Author = "human" | "agent";
export type Creator = "human" | "agent" | "cli";

// Sentinel ("WORKING" | "STAGED" | "SCRATCH" | "HEAD") or sha/ref. WORKING/SCRATCH
// track live content.
export type GitRef = string;

// Sentinel for summary-anchored feedback (`@` never starts a repo path). Quote is
// the anchor of record; automatic re-anchor skips these except a drifted review
// summary (`r3 reanchor --quote`).
export const SUMMARY_FILE = "@summary";

// Cap stored anchor quotes to this many leading lines: a short span relocates far
// more reliably than a paragraphs-long one. The recorded line range keeps the full
// span either way — only the quote is truncated.
export const MAX_QUOTE_LINES = 4;

// The one truncation every quote producer runs through, so a quote's shape can't
// depend on which gesture made it: the web's text selections and gutter picks
// (web/src/selection.ts, web/src/gutter.ts) and the server's derived quotes
// (server/reviews.ts deriveQuote). Trailing whitespace goes first — it is never
// part of what the note points at, and it would otherwise count toward the cap as
// a blank final line. Truncation is verbatim (no ellipsis) so the result still
// matches the source, which is what re-anchoring searches for.
export function capQuote(raw: string): string {
  // trimEnd(), not /\s+$/: it strips the same character set, and the regex
  // backtracks per start offset over a long whitespace run (quadratic on the
  // mostly-blank ranges deriveQuote can be handed).
  const quote = raw.trimEnd();
  const lines = quote.split("\n");
  return lines.length > MAX_QUOTE_LINES ? lines.slice(0, MAX_QUOTE_LINES).join("\n") : quote;
}

// Row ceiling on one expand-context request (GET …/diff-context). The server
// rejects a larger range; the client clamps "show all" to it and reveals a huge
// gap in successive bites. Shared so the two can't drift into a control that
// silently 400s.
export const MAX_CONTEXT_ROWS = 5000;

export type ReviewSource =
  // kind: 'diff' — provenance only ("" = piped); content is stored patches.
  { base: GitRef; head: GitRef } | { ref: GitRef; files: string[] }; // kind: 'files' — ref:'SCRATCH' = adhoc scratch dir

// One stored diff round. Immutable once added — independent of other rounds.
export interface PatchMeta {
  seq: number; // monotonic per review (1, 2, …); never reused after `diff rm`
  label: string | null; // short human hint, e.g. "abc123^..abc123" or "round 2: fixes"
  // A free-form overview of what this round changes overall — set once when the
  // round is appended (immutable, like the round itself). `label` is the title;
  // `summary` is the prose. Shown per-round in the UI.
  summary: string | null;
  created_at: string;
}

// List shape for `r3 diff list` / GET …/patches: meta + cheap content stats.
export interface PatchInfo extends PatchMeta {
  files: string[];
  additions: number;
  deletions: number;
}

// Frozen full-text capture of a files review. Feedback stays on the live file.
export interface SnapshotMeta {
  seq: number; // monotonic per review (1, 2, …)
  label: string | null; // short human hint, e.g. "before feedback" / "round 2"
  created_at: string;
  files: string[]; // review-relative paths captured in this snapshot
}

// A snapshot selector value: a snapshot `seq`, or the sentinel WORKING = the live
// working content (the default "to"). The client also has a NONE "from" state
// (no diff — a plain full-file view of "to"), which never reaches the server.
export type SnapshotRef = number | "WORKING";

// Which worktree a review was created in. `name` is the basename
// under `.git/worktrees/<name>` (stable across `git worktree move`); empty for
// the primary worktree. `pathHint` is the last-known path — never trusted for
// resolution (a move tracks, a copy doesn't); resolution is by name → branch.
export interface WorktreeDescriptor {
  name: string;
  branch: string | null;
  pathHint: string;
}

// Identity is the shared git object store (common-dir): worktrees of one clone
// are one repo; copies are not.
export interface RepoRecord {
  id: string; // repo_<short>
  commonDir: string; // realpath of `git rev-parse --git-common-dir`
  name: string | null; // display label (basename default, editable)
  remote: string | null; // git remote url; a relink hint only
  lastSeen: string;
  createdAt: string;
  // Live, derived (not stored): is the repo's path present on disk right now?
  present?: boolean;
}

export interface Review {
  id: string; // review_<short>
  repo_id: string; // -> RepoRecord
  worktree: WorktreeDescriptor | null; // captured at creation
  title: string | null;
  // A short, free-form overview of the review (what it's about / what changed),
  // shown collapsibly in the UI. No hard length cap; ~300 words is the sweet spot.
  summary: string | null;
  kind: ReviewKind;
  source: ReviewSource;
  meta: Record<string, string>; // free-form, queryable (e.g. { session, agent, branch })
  status: ReviewStatus;
  created_by: Creator;
  created_at: string;
  updated_at: string;
  // Live, derived (not stored): is an agent currently `r3 watch`-ing this review?
  // Set by GET /api/reviews (ephemeral connection presence, like RepoRecord.present)
  // so clients can surface and rank watched reviews to the top.
  watching?: boolean;
  // Live, derived from unexpired feedback claims: is an agent actively working
  // on at least one item in this review? Unlike `watching` this survives a daemon
  // restart until its lease expires, but it is still operational presence rather
  // than review lifecycle state.
  working?: boolean;
}

export interface Feedback {
  id: string; // feedback_<short> — the agent refers to this id
  review_id: string;
  author: Author;
  body: string;
  file: string; // repo-relative path
  side: DiffSide | null; // diff side; null for files/raw
  // Whole-file note: real `file`, but line_start/line_end/quote all null. Re-anchor
  // skips these. Distinct from general (review-level) feedback, which has no `file`.
  line_start: number | null;
  line_end: number | null;
  quote: string | null; // verbatim selected text — the anchor of record
  code_sha: string | null; // sha of the anchored span, recorded at anchor time; currently unread (staleness is surfaced via `anchor`)
  anchor: AnchorState;
  status: FeedbackStatus;
  // Which stored diff round the anchor lives in (diff reviews only; null for
  // files reviews and legacy diff feedback = "the only/first round").
  patch_seq: number | null;
  created_at: string;
  updated_at: string;
  // Last prompt hand-off; null = never sent. Agent-authored feedback is born delivered.
  sent_at: string | null;
  // Status changed since last hand-off (bare Resolve/Reopen posts no reply).
  status_unsent: boolean;
}

export interface Reply {
  id: string; // reply_<short>
  feedback_id: string;
  author: Author;
  body: string;
  // Optional anchor: where this reply's change landed. The feedback
  // keeps pointing at what the human commented on; an anchored reply points at
  // the round that addresses it ("↳ addressed in diff N"). Validated against the
  // stored patch at post time, and stable forever since rounds are immutable.
  patch_seq: number | null;
  file: string | null;
  line_start: number | null;
  line_end: number | null;
  quote: string | null;
  created_at: string;
  // When this reply was last delivered to the agent; null = never
  // sent. Only human replies gate an unsent prompt — a human follow-up posted
  // after the last hand-off re-enables the prompt for its feedback.
  sent_at: string | null;
  // The review version an agent's inline `@path:Lx-y` code references in `body`
  // resolve against, captured at post time: the latest diff round (diff reviews)
  // or content snapshot (files reviews); null when there was none. Immutable, so a
  // ref keeps pointing at the code as it was when the reply was written — the agent
  // orders snapshot/round vs. reply to pin old-vs-new (split replies to cite both).
  ref_version: number | null;
}

// Time-bounded presence lease; not a third Feedback.status.
export interface FeedbackClaim {
  feedback_id: string;
  session: string; // human-readable display label
  agentId?: string; // stable machine handle when the agent host has one
  claimed_at: string;
  renewed_at: string;
  expires_at: string;
}

export interface FeedbackWithReplies extends Feedback {
  replies: Reply[];
  claim: FeedbackClaim | null;
}

// Human replies the agent hasn't been handed (agent replies never count).
export function unsentHumanReplies(fb: FeedbackWithReplies): Reply[] {
  return fb.replies.filter((r) => r.author === "human" && r.sent_at == null);
}

// Shared unsent predicate (prompt, CLI watch, Copy/Submit). Never-delivered
// counts only while still open; status_unsent is the delivery flag for a status flip.
export function hasUnsentContent(fb: FeedbackWithReplies): boolean {
  if (fb.sent_at == null) return fb.status === "open";
  return unsentHumanReplies(fb).length > 0 || fb.status_unsent;
}

export interface ReviewDetail extends Review {
  feedback: FeedbackWithReplies[];
  // Resolution status of the review's repo/worktree. `stale` =
  // the live tree couldn't be resolved (worktree removed, or repo path missing),
  // so content is unavailable/last-known and the UI offers relink. `repoName` +
  // `branch` are display sugar read off the resolved repo/descriptor.
  stale: boolean;
  repoName: string | null;
  branch: string | null;
  // Absolute path of a scratch review's directory (where the agent drops files);
  // null for non-scratch reviews. Shown in the UI so the human knows where content
  // comes from, and surfaced in the empty state before any files are added.
  scratchDir: string | null;
  // Subdirectory names inside the scratch dir. Scratch reviews are flat, so these
  // are ignored (not shown/watched); the UI warns so files in them aren't lost.
  scratchIgnoredDirs: string[];
  // The stored diff rounds (meta only; content via GET /api/reviews/:id/diff).
  // Empty for files reviews and for legacy diff reviews still rendered live.
  patches: PatchMeta[];
  // The files review's content snapshots, oldest first. Empty for
  // diff reviews. The UI's from/to selectors diff any two — or one vs. live.
  snapshots: SnapshotMeta[];
}

// ---- request bodies ----

export interface CreateReviewBody {
  // Omitted for a scratch review (pass `scratch:true` instead — the server makes an
  // empty files/SCRATCH review + a per-review directory); required otherwise.
  kind?: ReviewKind;
  source?: ReviewSource;
  // Create an adhoc scratch review: no files, a per-review directory the agent
  // drops files into (its path is returned as `scratchDir`); the daemon watches it.
  scratch?: boolean;
  // For kind:'diff': a raw unified diff to store as round 1 instead of having the
  // server snapshot it from source refs (the `--stdin-diff` path). When set,
  // `source` may be omitted (provenance defaults to { base:"", head:"" }).
  patch?: string;
  label?: string | null; // round-1 label override
  meta?: Record<string, string>;
  title?: string | null;
  summary?: string | null;
  created_by?: Creator;
}

// Edit a review's mutable header fields (PATCH /api/reviews/:id). Any subset is
// allowed; a field left absent is untouched, and `title`/`summary` set to null
// clears it. `status` drives approve/abandon/reopen.
export interface UpdateReviewBody {
  status?: ReviewStatus;
  meta?: Record<string, string>;
  title?: string | null;
  summary?: string | null;
  // Optional "next steps for the agent" captured when approving a review; the
  // server stashes it in `meta.next_steps` (queryable, invisible unless asked)
  // and `r3 watch` prints it to the agent when it sees the approval. Passing ""
  // clears it. Only meaningful alongside `status:'approved'`.
  note?: string | null;
}

// Append a diff round to a review (POST /api/reviews/:id/patches).
export interface AddPatchBody {
  patch: string; // raw unified diff text
  label?: string | null;
  summary?: string | null; // overview of what this round changes overall
}

// Capture a content snapshot of a files review (POST /api/reviews/:id/snapshots).
// The server reads each file currently in the review and stores its full content;
// no body content is uploaded.
export interface CreateSnapshotBody {
  label?: string | null;
}

// Edit a files review's membership (POST /api/reviews/:id/files).
export interface ReviewFilesBody {
  add?: string[];
  remove?: string[];
}

export interface CreateFeedbackBody {
  // Omitted/empty ⇒ general (review-level) feedback. A real path with null
  // lineStart/lineEnd/quote ⇒ a whole-file note (anchored to the file, not a span).
  file?: string;
  side?: DiffSide | null;
  lineStart: number | null;
  lineEnd: number | null;
  quote?: string | null;
  body: string;
  author?: Author;
  patchSeq?: number | null; // diff reviews: which round the anchor is in
}

// Re-point a note at where its quoted text MOVED to. `quote` is the anchor of
// record and is never rewritten here: on a files-review anchor the server keeps
// the stored quote and reads `lineStart`/`lineEnd` as the new hint (a `quote` that
// differs from it is rejected, not applied), and only a whole-file note — which has
// none — can gain one. The exception is a review-summary note, where the quote IS
// the anchor (no file, no lines to move) and so must be supplied.
export interface ReanchorBody {
  file?: string;
  lineStart: number | null;
  lineEnd: number | null;
  quote?: string | null;
}

export interface AddReplyBody {
  author?: Author;
  body: string;
  // Optional pin: where the change addressing this feedback landed. `patchSeq`
  // names a stored round; file/lines/quote locate the spot inside it (new side).
  patchSeq?: number | null;
  file?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  quote?: string | null;
}

// PUT /api/feedback/:id/claim. Repeating it for the same owner renews the
// feedback's lease; another active owner gets a conflict. The daemon supplies
// the review's meta.session (then "agent") when session is omitted.
export interface ClaimFeedbackBody {
  session?: string;
  agentId?: string;
  leaseSeconds?: number;
}

export const DEFAULT_CLAIM_LEASE_SECONDS = 60 * 60;
export const MIN_CLAIM_LEASE_SECONDS = 60;
export const MAX_CLAIM_LEASE_SECONDS = 4 * 60 * 60;

// Edit a reply's prose (PATCH /api/replies/:id). A human-only convenience for
// fixing the last thing they wrote — like PATCH /api/feedback/:id, it's a UI
// affordance with no CLI command; the pin/anchor fields stay immutable.
export interface UpdateReplyBody {
  body: string;
}

// ---- viewed marks (per-reviewer read-progress) ----
// Key is content identity (`d:<seq>:<path>`, `f:<path>@<sha>`), not a path.
export interface ViewedResponse {
  keys: string[];
}

// PUT /api/reviews/:id/viewed — set (`viewed:true`) or clear (`false`) one key.
export interface SetViewedBody {
  key: string;
  viewed: boolean;
}

// ---- git browsing shapes ----

export interface GitStatusEntry {
  path: string;
  index: string; // porcelain X
  worktree: string; // porcelain Y
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
}

export interface GitStatus {
  branch: string | null;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
}

export interface GitLogEntry {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  date: string; // ISO
  refs: string;
}

export interface GitTreeEntry {
  path: string; // repo-relative
  name: string;
  type: "blob" | "tree";
}

// ---- diff rendering shapes (server-parsed unified diff) ----

export type DiffLineType = "context" | "add" | "del" | "hunk";

export interface DiffLine {
  type: DiffLineType;
  oldLine: number | null;
  newLine: number | null;
  // Pre-highlighted inner HTML for the line content (Shiki). For 'hunk' rows
  // this is the literal @@ header text (not highlighted).
  html: string;
  text: string; // raw text of the line (no leading +/-/space), for quote anchoring
  // Hunk rows: held context for expand (`down` on the last hunk of each contiguous
  // run). Absent/zero = no expander.
  expandable?: { up: number; down: number };
}

export interface DiffFileChange {
  oldPath: string | null;
  newPath: string | null;
  path: string; // display path (newPath ?? oldPath)
  status: "added" | "deleted" | "modified" | "renamed";
  binary: boolean;
  additions: number;
  deletions: number;
  lines: DiffLine[]; // flat list including hunk header rows
}

export interface DiffResult {
  base: GitRef;
  head: GitRef;
  files: DiffFileChange[];
}

// One rendered diff round of a review (GET /api/reviews/:id/diff).
export interface PatchDiff extends PatchMeta {
  files: DiffFileChange[];
}

// One filled gap (GET …/diff-context): the unchanged rows the server holds for
// the requested NEW-side range. Always fully covers the range — a source that
// can't is a 404, not a short answer.
export interface DiffContextResponse {
  file: string;
  lines: DiffLine[];
}

// A diff review's full rendered content: its stored rounds, in seq order. A
// legacy review with no stored patches renders live from its source refs as a
// single synthetic round (seq 0).
export interface ReviewDiffResponse {
  rounds: PatchDiff[];
}

// A files review's derived diff between two snapshot refs (GET
// /api/reviews/:id/snapshot-diff). `from` is a snapshot seq; `to` is a snapshot
// seq or WORKING (live). Only changed files are included. The feedback that lands
// in this view is located client-side by quote, so this response is
// feedback-agnostic and cacheable.
export interface SnapshotDiffResponse {
  from: number;
  to: SnapshotRef;
  files: DiffFileChange[];
}

// ---- raw file rendering (kind: 'files') ----

// One entry in the syntax-theme picker (GET /api/themes): a curated light/dark
// family or a single bundled Shiki theme, grouped for the dropdown.
export interface ThemeOption {
  id: string;
  label: string;
  group: string;
}

// The current syntax theme's own editor colours (GET /api/theme-style): its
// background and default foreground, per light/dark slot. The client paints code
// surfaces with these (as --shiki-*-bg / --shiki-*) so a theme like Nord looks
// like it does in an editor instead of pale token colours on r3's neutral card.
// Blank strings ⇒ the client keeps its neutral fallback.
export interface ThemeStyle {
  lightBg: string;
  darkBg: string;
  lightFg: string;
  darkFg: string;
  // The theme's PALETTE STYLESHEET — where every rendered token span's colour
  // comes from. One rule per distinct foreground the theme can hand a token
  // (`html:not(.dark) .sl3{color:#…}` for the light slot, `html.dark .sd7{…}`
  // for the dark one) plus the font-style rules; the spans carry only the
  // matching class names. Spans used to carry both colours inline instead
  // (`style="--shiki-light:…;--shiki-dark:…"`), which measured 12x the source
  // size in blob JSON and gave every mounted span its own computed style. The
  // client injects this once as `<style data-r3-theme-css>`, replacing it when
  // the theme changes. Blank ⇒ no palette (unloadable theme): those lines fall
  // back to inline styles on a `.sx` span, so nothing renders colourless.
  css: string;
}

export interface RenderedFileLine {
  lineNo: number;
  // Shiki-highlighted inner HTML. Token spans carry palette classes
  // (`<span class="sl3 sd7">`), coloured by ThemeStyle.css for the SAME theme —
  // both are per-theme, so a client must not mix a line from one theme's render
  // with another theme's stylesheet.
  html: string;
  text: string; // raw line text for anchoring
}

export interface RenderedFile {
  path: string;
  ref: GitRef;
  kind: "code" | "markdown";
  lang: string | null;
  sha: string;
  // For code: line-by-line highlighted rows. For markdown: `markdownHtml` holds
  // the rendered block HTML (with data-line attributes) and `lines` the raw
  // source lines used for anchoring + a source view. A relative link in that
  // HTML is an `a.r3-doclink` carrying the target's repo-relative path in
  // `data-r3-doc-file` (+ a heading slug in `data-r3-doc-hash`, matching a
  // heading's `data-r3-heading`) — resolved against `path`, for the client to
  // jump to rather than navigate (server/highlight.ts, web/src/doclinks.ts).
  lines: RenderedFileLine[];
  markdownHtml: string | null;
}

// ---- SSE events ----

export type ServerEvent =
  | { type: "review-updated"; reviewId: string }
  | { type: "feedback-updated"; reviewId: string; feedbackId: string }
  // `reviewIds` scopes the change to the open reviews whose watched files moved,
  // so a filtered SSE client (a single review view / `r3 watch <id>`) can ignore
  // an unrelated change. Absent/empty ⇒ broadcast to all (safe fallback).
  | { type: "file-changed"; paths: string[]; reviewIds?: string[] }
  | { type: "reviews-changed" }
  // a `watch` client connected/disconnected
  | { type: "watchers-changed"; reviewId: string }
  // the human hit Submit — any watching agent picks the feedback up now
  | { type: "submitted"; reviewId: string };

// How the agent holding a review's one slot is reached. `watch` is a process
// blocked on an SSE stream — the connection IS the slot, so the holder is live
// by construction. `listen` is a registered session inbox the daemon pushes to,
// which is only known-live at the instant it is probed. Presence renders the
// same either way (one indicator); the kind rides the wire because the two fail
// differently and `r3 watch`'s refusal should be able to say which it hit.
export type WatcherKind = "watch" | "listen";

// An agent waiting on a review — blocked in `r3 watch <id>`, or registered via
// `r3 listen <id>`.
export interface WatcherInfo {
  session: string; // human-readable display string (a session name)
  agentId?: string; // precise machine id, for other tools to jump to the agent
  kind: WatcherKind;
}

// `POST /api/reviews/:id/listen` — register this agent's harness inbox so the
// daemon can push a nudge on Submit/approve/abandon instead of the agent holding
// a process open. `socket`/`token` are read by the CLI from its own environment
// (Claude Code exports them to every child of a session).
//
// The token is a LIVE SESSION CREDENTIAL: the daemon keeps it in memory only and
// never writes it to the store. That is what makes the listener registry
// in-memory, and therefore what makes a daemon restart drop every listener.
//
// It is REQUIRED, because it is the only thing that makes delivery deterministic.
// Without an auth line the harness falls back to own-child verification, and
// whether the daemon is a descendant of the session is an accident of which
// session happened to spawn it — one per-user daemon spans every session but can
// be the child of at most one. A push from a non-descendant is HELD for approval
// (measured), and since we send no reply address we never learn that it was. So a
// tokenless registration is a coin flip resolved silently: it would look
// registered, answer 200 on Submit, and never fire. Refusing it up front — while
// the agent can still fall back to `r3 watch` — is the whole point.
export interface ListenRequest {
  session: string;
  agentId?: string;
  socket: string;
  token: string;
}
export interface ListenResponse {
  ok: true;
  session: string;
}
// 0 or 1 watchers; an array so clients keep the same shape.
export interface WatchersResponse {
  watchers: WatcherInfo[];
}
// `GET /api/events?session=` on a review another client already watches: 409,
// naming the holder so the refused agent can say who has it.
export interface WatchRefusedResponse {
  error: string;
  holder: WatcherInfo;
}
// Not a broadcast — a stream-local control frame the events endpoint writes to a
// watch connection just before closing it because the SAME client reconnected and
// took the slot. Without it the displaced process can't tell eviction from a
// dropped connection, so it would reconnect, evict its own successor, and the two
// would trade the slot forever.
export const SUPERSEDED_EVENT = "superseded";

// ---- auth (login token → session cookie when REQUIRE_LOGIN) ----

// GET /api/boot. `needsAuth:true` → login screen; `token` is then null.
export interface BootResponse {
  needsAuth: boolean;
  // The per-user API token when login isn't required (the SPA sends it as
  // x-r3-token, as it always has); null when login is required (the browser
  // authenticates by the session cookie alone, so the master token stays on the box).
  token: string | null;
}

// A login token's metadata (GET /api/auth/tokens, `r3 auth list-tokens`). The token
// value itself is hashed at rest and shown only once at creation — never returned.
export interface AuthTokenInfo {
  id: string; // authtok_<short> — the handle used to revoke
  label: string | null; // human hint (device/purpose)
  createdAt: string;
  lastUsedAt: string | null; // last successful login with this token; null if unused
  // (revoked tokens are dropped from every listing, so there's no `revokedAt` here —
  // the audit-trail column stays DB-side; see server/db.ts listAuthTokens.)
  // Request-scoped, not stored: true for the token that minted the caller's own
  // session cookie (GET /api/auth/tokens only). Revoking it would sign the caller
  // out, so the server refuses that DELETE and the UI disables its revoke button.
  // Absent when the caller used the per-user token (loopback SPA / CLI, no cookie).
  current?: boolean;
}

// POST /api/auth/login — trade a login token for a session cookie (Set-Cookie in the
// response). Same-origin gated, token-free (you have no session yet). 401 on a bad
// or revoked token.
export interface LoginBody {
  token: string;
}

// POST /api/auth/tokens — mint a login token. The raw `token` is returned ONCE here
// and never again (only its hash is stored); persist it somewhere safe.
export interface CreateAuthTokenBody {
  label?: string | null;
}
export interface CreateAuthTokenResponse {
  token: string; // the one-time plaintext login token
  info: AuthTokenInfo;
}
