// The domain model + HTTP contract shared by the server, the CLI, and the web
// SPA. The HTTP/JSON API is the product's contract, so these
// types are the single source of truth all three clients agree on.

export type ReviewKind = "diff" | "files";
export type ReviewStatus = "open" | "approved" | "abandoned";
export type FeedbackStatus = "open" | "accepted" | "refuted" | "resolved";
export type AnchorState = "anchored" | "outdated";
export type DiffSide = "old" | "new";
export type Author = "human" | "agent";
export type Creator = "human" | "agent" | "cli";
export type ReplyAction = "accept" | "refute" | "resolve" | "followup" | null;

// `WORKING` = the working tree, `STAGED` = the index, `SCRATCH` = an adhoc doc
// stored in the daemon's scratch dir (not git); anything else is a git ref/sha.
// `WORKING`/`SCRATCH` track live content and get re-read + re-anchored on change.
export type GitRef = string; // sentinel ("WORKING" | "STAGED" | "SCRATCH" | "HEAD") or sha/ref

// Feedback whose `file` is this sentinel is anchored to a *summary* (prose), not a
// repo file: the review's own summary when `patch_seq` is null, or a diff round's
// summary when `patch_seq` names that round. The `quote` is still the anchor of
// record; there's no worktree file to re-anchor against, so summary feedback is
// skipped by the automatic re-anchor pass. The `@` prefix keeps it clear of any
// repo-relative path (which never starts with `@/`).
export const SUMMARY_FILE = "@summary";

export type ReviewSource =
  // kind: 'diff' — provenance only (what round 1 was snapshotted from; "" = piped
  // in via stdin). The rendered content is the review's stored patches: an
  // append-only list of immutable diff "rounds", never re-derived from
  // these refs after creation.
  { base: GitRef; head: GitRef } | { ref: GitRef; files: string[] }; // kind: 'files' — ref:'SCRATCH' = adhoc doc(s) in the scratch dir

// One stored diff round of a `kind:'diff'` review. Rounds are
// immutable once added — feedback anchored to a round can never orphan — and
// independent: round N's line numbers owe nothing to round N-1's.
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

// A frozen capture of a files review's content at a moment. Unlike a
// diff review's stored rounds (which hold unified-diff *text*), a snapshot stores
// each file's *full content*, so the server can derive an accurate diff between
// any two snapshots — or a snapshot and the live working content — on demand.
// Snapshots are append-only + immutable, and feedback is NOT scoped to them: it
// stays anchored to the live file (quote-first) and is located by quote in
// whichever snapshot/diff view is shown. Only `kind:'files'` reviews have them.
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

// A registered project. Identity is the shared git object store
// (common-dir), so all worktrees of one clone are one repo and copies are not.
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
}

export interface Feedback {
  id: string; // feedback_<short> — the agent refers to this id
  review_id: string;
  author: Author;
  body: string;
  file: string; // repo-relative path
  side: DiffSide | null; // diff side; null for files/raw
  // A *whole-file* note carries a real `file` path but no span: `line_start`,
  // `line_end`, and `quote` are all null (the file itself is the anchor). Like
  // summary feedback it has no quote to relocate, so the automatic re-anchor pass
  // skips it and it never goes `outdated`. Distinct from general (review-level)
  // feedback, which has no `file` at all.
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
  // When this feedback was last delivered to the agent via a prompt hand-off
  // (Copy / `r3 prompt` / `r3 watch`); null = never sent. Drives unsent-only
  // prompts — a prompt re-sends only feedback the agent hasn't seen.
  sent_at: string | null;
}

export interface Reply {
  id: string; // reply_<short>
  feedback_id: string;
  author: Author;
  action: ReplyAction; // drives the parent feedback's status; null = plain message
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
}

export interface FeedbackWithReplies extends Feedback {
  replies: Reply[];
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

export interface ReanchorBody {
  file?: string;
  lineStart: number | null;
  lineEnd: number | null;
  quote?: string | null;
}

export interface AddReplyBody {
  author?: Author;
  action?: ReplyAction;
  body: string;
  // Optional pin: where the change addressing this feedback landed. `patchSeq`
  // names a stored round; file/lines/quote locate the spot inside it (new side).
  patchSeq?: number | null;
  file?: string | null;
  lineStart?: number | null;
  lineEnd?: number | null;
  quote?: string | null;
}

// Edit a reply's prose (PATCH /api/replies/:id). A human-only convenience for
// fixing the last thing they wrote — like PATCH /api/feedback/:id, it's a UI
// affordance with no CLI command; the pin/anchor fields stay immutable.
export interface UpdateReplyBody {
  body: string;
}

// ---- viewed marks (per-reviewer read-progress; server-persisted) ----

// r3 is single-user (one daemon, one token), so "have I read this file" is this
// reviewer's progress through the review — server-persisted (GET/PUT below) so it
// follows the review across browsers/devices, not just the tab that set it. A
// `key` is an opaque content-identity token minted by the client: `d:<seq>:<path>`
// for a diff round's file (per round, immutable) and `f:<path>@<sha>` for a live
// files-review file (so a file whose content changed drops its mark automatically,
// since the new sha yields a new key). No SSE — a second tab reconciles on refetch.
// It's a UI affordance with no CLI surface (the agent doesn't consume it).
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
}

export interface RenderedFileLine {
  lineNo: number;
  html: string; // Shiki-highlighted inner HTML
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
  // source lines used for anchoring + a source view.
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
  // a `watch` client connected/disconnected, or the human hit Submit
  | { type: "watchers-changed"; reviewId: string }
  | { type: "submitted"; reviewId: string };

// An agent currently blocked on `r3 watch <id>` for a review.
export interface WatcherInfo {
  session: string; // human-readable display string (a session name)
  agentId?: string; // precise machine id, for other tools to jump to the agent
}
export interface WatchersResponse {
  watchers: WatcherInfo[];
}
