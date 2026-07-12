// bun:sqlite persistence. One global DB for all the
// user's repos at `$XDG_STATE_HOME/r3/r3.sqlite`, keyed by a `repos` registry.
// This module is pure storage: schema + typed row<->object mapping + CRUD.
// Domain rules (status transitions, anchor drift) live in reviews.ts; repo
// identity + worktree resolution live in repo.ts.

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  AnchorState,
  Author,
  Creator,
  Feedback,
  FeedbackStatus,
  PatchMeta,
  Reply,
  ReplyAction,
  RepoRecord,
  Review,
  ReviewKind,
  ReviewSource,
  ReviewStatus,
  SnapshotMeta,
  WorktreeDescriptor,
} from "../shared/types.ts";
import { stateDbPath } from "./config.ts";
import { newFeedbackId, newReplyId, newRepoId, newReviewId, nowIso } from "./ids.ts";

const DB_PATH = stateDbPath();
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");

// The reviews table body — one source of truth for the columns.
const REVIEWS_COLUMNS = `
  id          TEXT PRIMARY KEY,
  repo_id     TEXT NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  worktree    TEXT,
  title       TEXT,
  summary     TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('diff','files')),
  source      TEXT NOT NULL,
  meta        TEXT NOT NULL DEFAULT '{}',
  status      TEXT NOT NULL DEFAULT 'open',
  created_by  TEXT NOT NULL DEFAULT 'human',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
`;

db.exec(`
CREATE TABLE IF NOT EXISTS repos (
  id          TEXT PRIMARY KEY,
  common_dir  TEXT NOT NULL UNIQUE,
  name        TEXT,
  remote      TEXT,
  last_seen   TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reviews (${REVIEWS_COLUMNS});
CREATE TABLE IF NOT EXISTS feedback (
  id          TEXT PRIMARY KEY,
  review_id   TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  author      TEXT NOT NULL,
  body        TEXT NOT NULL,
  file        TEXT NOT NULL,
  side        TEXT,
  line_start  INTEGER,
  line_end    INTEGER,
  quote       TEXT,
  code_sha    TEXT,
  anchor      TEXT NOT NULL DEFAULT 'anchored',
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  sent_at     TEXT
);
CREATE TABLE IF NOT EXISTS replies (
  id          TEXT PRIMARY KEY,
  feedback_id TEXT NOT NULL REFERENCES feedback(id) ON DELETE CASCADE,
  author      TEXT NOT NULL,
  action      TEXT,
  body        TEXT NOT NULL,
  patch_seq   INTEGER,
  file        TEXT,
  line_start  INTEGER,
  line_end    INTEGER,
  quote       TEXT,
  created_at  TEXT NOT NULL,
  sent_at     TEXT,
  ref_version INTEGER
);
CREATE TABLE IF NOT EXISTS patches (
  review_id   TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  label       TEXT,
  summary     TEXT,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (review_id, seq)
);
CREATE TABLE IF NOT EXISTS snapshots (
  review_id   TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL,
  label       TEXT,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (review_id, seq)
);
CREATE TABLE IF NOT EXISTS snapshot_files (
  review_id   TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  path        TEXT NOT NULL,
  content     TEXT NOT NULL,
  sha         TEXT NOT NULL,
  skipped     INTEGER,
  PRIMARY KEY (review_id, seq, path),
  FOREIGN KEY (review_id, seq) REFERENCES snapshots(review_id, seq) ON DELETE CASCADE
);
-- Per-reviewer "viewed" marks. One row per (review, content
-- key); cascades away with the review (and, transitively, on repo-forget), so
-- there is no lifetime/quota to manage. The key is opaque: d:<seq>:<path> or
-- f:<path>@<sha>.
CREATE TABLE IF NOT EXISTS viewed_marks (
  review_id   TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  key         TEXT NOT NULL,
  PRIMARY KEY (review_id, key)
);
CREATE INDEX IF NOT EXISTS feedback_by_review ON feedback(review_id);
CREATE INDEX IF NOT EXISTS replies_by_feedback ON replies(feedback_id);
`);
// NOTE: the reviews expression indexes (reviews_by_repo, reviews_by_session) are
// created AFTER the defensive migrations below, not in the block above — building
// an index over a column a legacy table hasn't been migrated to yet would throw
// at load. Keep every reviews index in that post-migration block so the ordering
// invariant is obvious; don't reintroduce a copy here.

// Defensive forward-migration: add the v2 columns to a reviews table that
// predates them (a global DB created by an earlier v2 build). New global DBs get
// them from the CREATE above; ADD COLUMN is nullable since existing rows have no
// value.
function hasColumn(table: string, col: string): boolean {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return cols.some((c) => c.name === col);
}
if (!hasColumn("reviews", "repo_id")) db.exec("ALTER TABLE reviews ADD COLUMN repo_id TEXT");
if (!hasColumn("reviews", "worktree")) db.exec("ALTER TABLE reviews ADD COLUMN worktree TEXT");
// A short, editable overview of the review (nullable; existing rows have none).
if (!hasColumn("reviews", "summary")) db.exec("ALTER TABLE reviews ADD COLUMN summary TEXT");
// Stored-diff rounds + reply pins: feedback anchors into a
// round; a reply optionally pins where the change addressing it landed.
if (!hasColumn("feedback", "patch_seq"))
  db.exec("ALTER TABLE feedback ADD COLUMN patch_seq INTEGER");
for (const [col, type] of [
  ["patch_seq", "INTEGER"],
  ["file", "TEXT"],
  ["line_start", "INTEGER"],
  ["line_end", "INTEGER"],
  ["quote", "TEXT"],
] as const) {
  if (!hasColumn("replies", col)) db.exec(`ALTER TABLE replies ADD COLUMN ${col} ${type}`);
}
// Per-round overview of what the round changes (nullable; older rounds have none).
if (!hasColumn("patches", "summary")) db.exec("ALTER TABLE patches ADD COLUMN summary TEXT");
// Delivered-to-agent tracking: when this feedback/reply was last
// handed off in a prompt. Nullable — existing rows migrate to NULL, so on first
// upgrade everything counts as unsent once (a one-time re-send bootstrap).
if (!hasColumn("feedback", "sent_at")) db.exec("ALTER TABLE feedback ADD COLUMN sent_at TEXT");
if (!hasColumn("replies", "sent_at")) db.exec("ALTER TABLE replies ADD COLUMN sent_at TEXT");
// The version an agent reply's inline `@path:Lx-y` refs resolve against — the
// latest round (diff) / snapshot (files) at post time. Nullable; legacy replies
// migrate to NULL (their refs, if any, resolve live/best-effort).
if (!hasColumn("replies", "ref_version"))
  db.exec("ALTER TABLE replies ADD COLUMN ref_version INTEGER");
// Snapshot "present but non-diffable" marker: a file that exists at
// capture time but is binary/oversize is stored as a marker row (content='',
// skipped=1) instead of being omitted, so the derived diff renders it as a binary
// placeholder rather than misreading it as a full deletion. Nullable — legacy
// snapshot_files rows migrate to NULL (= not skipped).
if (!hasColumn("snapshot_files", "skipped"))
  db.exec("ALTER TABLE snapshot_files ADD COLUMN skipped INTEGER");

// Convert legacy adhoc-doc reviews (the removed `kind:'doc'`) into the scratch
// files form: kind='files', source={ ref:'SCRATCH', files:['<id>.md'] }, carrying
// over the old `source.doc` filename. Idempotent — no rows match once converted.
// The paired file move (docs/ -> scratch/) runs in scratch.migrateLegacyDocFiles().
db.exec(`
  UPDATE reviews
     SET kind = 'files',
         source = json_object('ref', 'SCRATCH', 'files', json_array(json_extract(source, '$.doc')))
   WHERE kind = 'doc'
`);

// The repo_id index is created AFTER the migrations above, so it never references
// a column a legacy table is still missing (which would throw at load).
db.exec("CREATE INDEX IF NOT EXISTS reviews_by_repo ON reviews(repo_id)");
db.exec(
  "CREATE INDEX IF NOT EXISTS reviews_by_session ON reviews(json_extract(meta, '$.session'))",
);

// Defensive re-mint on the vanishing chance a freshly-minted id (ids.ts) clashes
// with an existing PRIMARY KEY. Ids carry 48 random bits, so a clash is
// astronomically unlikely — but an uncaught SQLITE_CONSTRAINT_PRIMARYKEY would
// bubble up as a 500 and *lose the write*, so the auto-mint insert paths retry
// with a fresh id a few times before giving up. Only PRIMARY KEY collisions
// retry: re-minting can't help a UNIQUE(common_dir) race or a foreign-key
// violation, which rethrow unchanged. Callers that supply their own id (a scratch
// review whose directory is already named for it) must NOT use this — a re-mint
// would orphan that directory.
function isPrimaryKeyCollision(err: unknown): boolean {
  return (err as { code?: string })?.code === "SQLITE_CONSTRAINT_PRIMARYKEY";
}
function insertWithMintedId<T>(mint: () => string, insert: (id: string) => T): T {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; ; attempt++) {
    const id = mint();
    try {
      return insert(id);
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS || !isPrimaryKeyCollision(err)) throw err;
      // else: id collision — loop and re-mint a fresh one.
    }
  }
}

// ---- row types (as stored) ----

export interface ReviewRow {
  id: string;
  repo_id: string;
  worktree: string | null;
  title: string | null;
  summary: string | null;
  kind: ReviewKind;
  source: string;
  meta: string;
  status: ReviewStatus;
  created_by: Creator;
  created_at: string;
  updated_at: string;
}
interface RepoRow {
  id: string;
  common_dir: string;
  name: string | null;
  remote: string | null;
  last_seen: string;
  created_at: string;
}
interface FeedbackRow {
  id: string;
  review_id: string;
  author: Author;
  body: string;
  file: string;
  side: string | null;
  line_start: number | null;
  line_end: number | null;
  quote: string | null;
  code_sha: string | null;
  anchor: AnchorState;
  status: FeedbackStatus;
  patch_seq: number | null;
  created_at: string;
  updated_at: string;
  sent_at: string | null;
}
interface ReplyRow {
  id: string;
  feedback_id: string;
  author: Author;
  action: ReplyAction;
  body: string;
  patch_seq: number | null;
  file: string | null;
  line_start: number | null;
  line_end: number | null;
  quote: string | null;
  created_at: string;
  sent_at: string | null;
}
interface PatchRow {
  review_id: string;
  seq: number;
  label: string | null;
  summary: string | null;
  body: string;
  created_at: string;
}

function rowToReview(r: ReviewRow): Review {
  return {
    id: r.id,
    repo_id: r.repo_id,
    worktree: r.worktree ? (JSON.parse(r.worktree) as WorktreeDescriptor) : null,
    title: r.title,
    summary: r.summary,
    kind: r.kind,
    source: JSON.parse(r.source) as ReviewSource,
    meta: JSON.parse(r.meta) as Record<string, string>,
    status: r.status,
    created_by: r.created_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}
function rowToRepo(r: RepoRow): RepoRecord {
  return {
    id: r.id,
    commonDir: r.common_dir,
    name: r.name,
    remote: r.remote,
    lastSeen: r.last_seen,
    createdAt: r.created_at,
  };
}
function rowToFeedback(r: FeedbackRow): Feedback {
  return {
    id: r.id,
    review_id: r.review_id,
    author: r.author,
    body: r.body,
    file: r.file,
    side: (r.side as Feedback["side"]) ?? null,
    line_start: r.line_start,
    line_end: r.line_end,
    quote: r.quote,
    code_sha: r.code_sha,
    anchor: r.anchor,
    status: r.status,
    patch_seq: r.patch_seq,
    created_at: r.created_at,
    updated_at: r.updated_at,
    sent_at: r.sent_at,
  };
}

// ---- repos registry ----

export function getRepoById(id: string): RepoRecord | null {
  const r = db.query("SELECT * FROM repos WHERE id = $id").get({ $id: id }) as RepoRow | null;
  return r ? rowToRepo(r) : null;
}

export function getRepoByCommonDir(commonDir: string): RepoRecord | null {
  const r = db
    .query("SELECT * FROM repos WHERE common_dir = $cd")
    .get({ $cd: commonDir }) as RepoRow | null;
  return r ? rowToRepo(r) : null;
}

export function listRepos(): RepoRecord[] {
  const rows = db.query("SELECT * FROM repos ORDER BY last_seen DESC").all() as RepoRow[];
  return rows.map(rowToRepo);
}

// Auto-register an unknown common-dir on first touch; otherwise bump last_seen
// (and learn a remote we didn't have). Keyed on the UNIQUE common_dir.
export function registerRepo(commonDir: string, name: string, remote: string | null): RepoRecord {
  const existing = getRepoByCommonDir(commonDir);
  const ts = nowIso();
  if (existing) {
    db.query(
      "UPDATE repos SET last_seen = $ts, remote = COALESCE($remote, remote) WHERE id = $id",
    ).run({ $ts: ts, $remote: remote, $id: existing.id });
    return getRepoById(existing.id)!;
  }
  const id = insertWithMintedId(newRepoId, (id) => {
    db.query(
      `INSERT INTO repos (id, common_dir, name, remote, last_seen, created_at)
       VALUES ($id, $cd, $name, $remote, $ts, $ts)`,
    ).run({ $id: id, $cd: commonDir, $name: name, $remote: remote, $ts: ts });
    return id;
  });
  return getRepoById(id)!;
}

export function touchRepo(id: string): void {
  db.query("UPDATE repos SET last_seen = $ts WHERE id = $id").run({ $id: id, $ts: nowIso() });
}

// Relink: point a moved repo's row at its new common-dir (no review rows touched,
// since they reference the immutable repo_id). Returns null if the id is unknown.
export function relinkRepo(id: string, commonDir: string): RepoRecord | null {
  if (!getRepoById(id)) return null;
  db.query("UPDATE repos SET common_dir = $cd, last_seen = $ts WHERE id = $id").run({
    $cd: commonDir,
    $ts: nowIso(),
    $id: id,
  });
  return getRepoById(id);
}

export function renameRepo(id: string, name: string): RepoRecord | null {
  if (!getRepoById(id)) return null;
  db.query("UPDATE repos SET name = $name WHERE id = $id").run({ $name: name, $id: id });
  return getRepoById(id);
}

// Forget a repo and (via ON DELETE CASCADE) all its reviews/feedback/replies.
export function deleteRepo(id: string): boolean {
  const r = db.query("DELETE FROM repos WHERE id = $id").run({ $id: id });
  return r.changes > 0;
}

// ---- reviews ----

export function createReview(input: {
  // Caller-supplied id (a scratch review's directory is named for its id and
  // created before this row exists — reviews.createScratchReview), so a re-mint
  // would orphan it; defaults to a fresh id for the common case.
  id?: string;
  repoId: string;
  worktree?: WorktreeDescriptor | null;
  kind: ReviewKind;
  source: ReviewSource;
  meta?: Record<string, string>;
  title?: string | null;
  summary?: string | null;
  created_by?: Creator;
}): Review {
  const ts = nowIso();
  const doInsert = (id: string) => {
    db.query(
      `INSERT INTO reviews (id, repo_id, worktree, title, summary, kind, source, meta, status, created_by, created_at, updated_at)
       VALUES ($id, $repo_id, $worktree, $title, $summary, $kind, $source, $meta, 'open', $created_by, $ts, $ts)`,
    ).run({
      $id: id,
      $repo_id: input.repoId,
      $worktree: input.worktree ? JSON.stringify(input.worktree) : null,
      $title: input.title ?? null,
      $summary: input.summary ?? null,
      $kind: input.kind,
      $source: JSON.stringify(input.source),
      $meta: JSON.stringify(input.meta ?? {}),
      $created_by: input.created_by ?? "human",
      $ts: ts,
    });
    return id;
  };
  // A caller-supplied id (a scratch review whose directory is already named for
  // it) is inserted as-is — re-minting would orphan that directory, so a clash
  // must surface. An auto-minted id retries on the off chance of a PK collision.
  const id = input.id != null ? doInsert(input.id) : insertWithMintedId(newReviewId, doInsert);
  return getReview(id)!;
}

export function getReview(id: string): Review | null {
  const r = db.query("SELECT * FROM reviews WHERE id = $id").get({ $id: id }) as ReviewRow | null;
  return r ? rowToReview(r) : null;
}

export function listReviews(filter: {
  session?: string;
  meta?: Record<string, string>;
  status?: ReviewStatus;
  repoId?: string;
}): Review[] {
  const where: string[] = [];
  const params: Record<string, string> = {};
  if (filter.status) {
    where.push("status = $status");
    params.$status = filter.status;
  }
  if (filter.repoId) {
    where.push("repo_id = $repoId");
    params.$repoId = filter.repoId;
  }
  if (filter.session) {
    where.push("json_extract(meta, '$.session') = $session");
    params.$session = filter.session;
  }
  let i = 0;
  for (const [k, v] of Object.entries(filter.meta ?? {})) {
    // Sanitize the key to a bare json path segment (the value is a bound param).
    const safeKey = k.replace(/[^\w.]/g, "");
    // Defense in depth: a key that's entirely invalid chars sanitizes to "",
    // which would build the malformed path '$.' and make SQLite error the whole
    // query (a 500). Skip it — a sibling guard also drops empty keys at the route.
    if (!safeKey) continue;
    const key = `$m${i++}`;
    // json_extract path is a literal; the key is validated by the route layer.
    where.push(`json_extract(meta, '$.${safeKey}') = ${key}`);
    params[key] = v;
  }
  const sql =
    "SELECT * FROM reviews" +
    (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
    " ORDER BY updated_at DESC";
  const rows = db.query(sql).all(params) as ReviewRow[];
  return rows.map(rowToReview);
}

export function updateReview(
  id: string,
  fields: {
    status?: ReviewStatus;
    meta?: Record<string, string>;
    title?: string | null;
    summary?: string | null;
    note?: string | null;
  },
): Review | null {
  const cur = getReview(id);
  if (!cur) return null;
  // A `note` (the approval's "next steps for the agent") lives in the queryable
  // meta bag under `next_steps` — merged onto the base meta so a plain approve
  // doesn't wipe { session, agent, ... }. A blank note drops the key.
  let meta = fields.meta ?? cur.meta;
  if (fields.note !== undefined) {
    meta = { ...meta };
    delete meta.next_steps;
    if (fields.note) meta.next_steps = fields.note;
  }
  db.query(
    `UPDATE reviews SET status = $status, meta = $meta, title = $title, summary = $summary, updated_at = $ts WHERE id = $id`,
  ).run({
    $id: id,
    $status: fields.status ?? cur.status,
    $meta: JSON.stringify(meta),
    // Only overwrite title/summary when the caller passed the key — an absent
    // field leaves the column as-is, so a rename doesn't wipe the summary.
    $title: fields.title !== undefined ? fields.title : cur.title,
    $summary: fields.summary !== undefined ? fields.summary : cur.summary,
    $ts: nowIso(),
  });
  return getReview(id);
}

// Replace a review's source (files-membership edits). Kept separate from
// updateReview so the routine status/meta/title path can't touch it by accident.
export function updateReviewSource(id: string, source: ReviewSource): Review | null {
  if (!getReview(id)) return null;
  db.query("UPDATE reviews SET source = $source, updated_at = $ts WHERE id = $id").run({
    $id: id,
    $source: JSON.stringify(source),
    $ts: nowIso(),
  });
  return getReview(id);
}

function touchReview(id: string): void {
  db.query("UPDATE reviews SET updated_at = $ts WHERE id = $id").run({ $id: id, $ts: nowIso() });
}

export function deleteReview(id: string): boolean {
  const r = db.query("DELETE FROM reviews WHERE id = $id").run({ $id: id });
  return r.changes > 0;
}

// ---- feedback ----

export function createFeedback(
  reviewId: string,
  input: {
    author?: Author;
    body: string;
    file: string;
    side?: Feedback["side"];
    line_start: number | null;
    line_end: number | null;
    quote?: string | null;
    code_sha?: string | null;
    patch_seq?: number | null;
  },
): Feedback {
  const ts = nowIso();
  // Auto-minted id: retry on the vanishing chance of a PK collision (see
  // insertWithMintedId) so a clash re-mints rather than 500s + drops the note.
  const id = insertWithMintedId(newFeedbackId, (id) => {
    db.query(
      `INSERT INTO feedback
         (id, review_id, author, body, file, side, line_start, line_end, quote, code_sha, anchor, status, patch_seq, created_at, updated_at)
       VALUES ($id, $review_id, $author, $body, $file, $side, $ls, $le, $quote, $sha, 'anchored', 'open', $patch_seq, $ts, $ts)`,
    ).run({
      $id: id,
      $review_id: reviewId,
      $author: input.author ?? "human",
      $body: input.body,
      $file: input.file,
      $side: input.side ?? null,
      $ls: input.line_start,
      $le: input.line_end,
      $quote: input.quote ?? null,
      $sha: input.code_sha ?? null,
      $patch_seq: input.patch_seq ?? null,
      $ts: ts,
    });
    return id;
  });
  touchReview(reviewId);
  return getFeedback(id)!;
}

export function getFeedback(id: string): Feedback | null {
  const r = db
    .query("SELECT * FROM feedback WHERE id = $id")
    .get({ $id: id }) as FeedbackRow | null;
  return r ? rowToFeedback(r) : null;
}

export function listFeedback(reviewId: string): Feedback[] {
  const rows = db
    .query("SELECT * FROM feedback WHERE review_id = $rid ORDER BY created_at ASC")
    .all({ $rid: reviewId }) as FeedbackRow[];
  return rows.map(rowToFeedback);
}

// Per-reviewer viewed-state. Keys are opaque content-identity
// tokens minted by the client; the daemon just stores/returns them per review.
export function listViewed(reviewId: string): string[] {
  const rows = db
    .query("SELECT key FROM viewed_marks WHERE review_id = $rid")
    .all({ $rid: reviewId }) as { key: string }[];
  return rows.map((r) => r.key);
}

export function setViewed(reviewId: string, key: string, viewed: boolean): void {
  if (viewed) {
    db.query("INSERT OR IGNORE INTO viewed_marks (review_id, key) VALUES ($rid, $key)").run({
      $rid: reviewId,
      $key: key,
    });
  } else {
    db.query("DELETE FROM viewed_marks WHERE review_id = $rid AND key = $key").run({
      $rid: reviewId,
      $key: key,
    });
  }
}

export function updateFeedback(
  id: string,
  fields: Partial<
    Pick<
      Feedback,
      | "body"
      | "status"
      | "anchor"
      | "file"
      | "side"
      | "line_start"
      | "line_end"
      | "quote"
      | "code_sha"
    >
  >,
): Feedback | null {
  const cur = getFeedback(id);
  if (!cur) return null;
  // Merge only *defined* fields: a partial update (e.g. reopen sends just
  // `status`) must not let an absent key arrive as `undefined` and clobber the
  // column to NULL — or, for bun:sqlite, throw on an undefined binding.
  const next = { ...cur };
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) (next as Record<string, unknown>)[k] = v;
  }
  db.query(
    `UPDATE feedback SET body=$body, status=$status, anchor=$anchor, file=$file, side=$side,
       line_start=$ls, line_end=$le, quote=$quote, code_sha=$sha, updated_at=$ts WHERE id=$id`,
  ).run({
    $id: id,
    $body: next.body,
    $status: next.status,
    $anchor: next.anchor,
    $file: next.file,
    $side: next.side,
    $ls: next.line_start,
    $le: next.line_end,
    $quote: next.quote,
    $sha: next.code_sha,
    $ts: nowIso(),
  });
  touchReview(cur.review_id);
  return getFeedback(id);
}

// Reset a feedback's delivery marker so it re-delivers on the next prompt.
// Called when a human edits the feedback *body* after it was already
// handed off: sent_at is otherwise only ever set, never cleared, so an edited
// note would silently stay "delivered" (Copy/Submit disabled, omitted from the
// unsent prompt) even though its text changed. A status-only edit does NOT clear
// it — status flips aren't content the agent needs re-sent.
export function clearFeedbackSent(id: string): void {
  db.query("UPDATE feedback SET sent_at = NULL WHERE id = $id").run({ $id: id });
}

export function deleteFeedback(id: string): boolean {
  const fb = getFeedback(id);
  if (!fb) return false;
  db.query("DELETE FROM feedback WHERE id = $id").run({ $id: id });
  touchReview(fb.review_id);
  return true;
}

// ---- replies ----

export function createReply(
  feedbackId: string,
  input: {
    author?: Author;
    action?: ReplyAction;
    body: string;
    // Optional pin: where the change addressing the feedback landed.
    patch_seq?: number | null;
    file?: string | null;
    line_start?: number | null;
    line_end?: number | null;
    quote?: string | null;
    // Version the reply's inline `@path:Lx-y` refs resolve against (round/snapshot).
    ref_version?: number | null;
  },
): Reply {
  const ts = nowIso();
  // Auto-minted id: retry on the vanishing chance of a PK collision (see
  // insertWithMintedId) so a clash re-mints rather than 500s + drops the reply.
  const id = insertWithMintedId(newReplyId, (id) => {
    db.query(
      `INSERT INTO replies (id, feedback_id, author, action, body, patch_seq, file, line_start, line_end, quote, ref_version, created_at)
       VALUES ($id, $fid, $author, $action, $body, $patch_seq, $file, $ls, $le, $quote, $ref_version, $ts)`,
    ).run({
      $id: id,
      $fid: feedbackId,
      $author: input.author ?? "agent",
      $action: input.action ?? null,
      $body: input.body,
      $patch_seq: input.patch_seq ?? null,
      $file: input.file ?? null,
      $ls: input.line_start ?? null,
      $le: input.line_end ?? null,
      $quote: input.quote ?? null,
      $ref_version: input.ref_version ?? null,
      $ts: ts,
    });
    return id;
  });
  return db.query("SELECT * FROM replies WHERE id = $id").get({ $id: id }) as Reply;
}

export function getReply(id: string): Reply | null {
  return (db.query("SELECT * FROM replies WHERE id = $id").get({ $id: id }) as Reply) ?? null;
}

// Edit a reply's prose in place (a human fixing their own last message). Only the
// body is mutable — the pin/anchor fields stay immutable. Bumps the
// parent review's updated_at (via the feedback) so open clients refetch.
export function updateReply(id: string, body: string): Reply | null {
  const cur = getReply(id);
  if (!cur) return null;
  db.query("UPDATE replies SET body = $body WHERE id = $id").run({ $id: id, $body: body });
  const fb = getFeedback(cur.feedback_id);
  if (fb) touchReview(fb.review_id);
  return getReply(id);
}

export function listReplies(feedbackId: string): Reply[] {
  return db
    .query("SELECT * FROM replies WHERE feedback_id = $fid ORDER BY created_at ASC")
    .all({ $fid: feedbackId }) as ReplyRow[] as Reply[];
}

// Stamp `sent_at = now` on the given feedback + reply ids in one transaction —
// marking them delivered to the agent. Bumps the review's
// updated_at so the change lands like any other feedback write; the SSE
// broadcast is the caller's (reviews.ts owns the side effects). A no-op for
// empty lists.
export function markContentSent(reviewId: string, feedbackIds: string[], replyIds: string[]): void {
  if (feedbackIds.length === 0 && replyIds.length === 0) return;
  const ts = nowIso();
  const stampFeedback = db.query("UPDATE feedback SET sent_at = $ts WHERE id = $id");
  const stampReply = db.query("UPDATE replies SET sent_at = $ts WHERE id = $id");
  db.transaction(() => {
    for (const id of feedbackIds) stampFeedback.run({ $ts: ts, $id: id });
    for (const id of replyIds) stampReply.run({ $ts: ts, $id: id });
  })();
  touchReview(reviewId);
}

// ---- patches (stored diff rounds) ----

// Append a round. seq is monotonic per review and never reused after a
// `diff rm` (MAX+1 over live rows can't regress because rounds are append-only
// and only ever removed from anywhere, not renumbered — but to be safe against
// "add, rm the max, add" reusing a seq that anchored feedback/pins still
// reference, take MAX over feedback/replies too).
export function addPatch(
  reviewId: string,
  body: string,
  label: string | null,
  summary: string | null = null,
): PatchMeta {
  const row = db
    .query(
      `SELECT MAX(n) AS n FROM (
         SELECT MAX(seq) AS n FROM patches WHERE review_id = $rid
         UNION ALL SELECT MAX(patch_seq) FROM feedback WHERE review_id = $rid
         UNION ALL SELECT MAX(r.patch_seq) FROM replies r
           JOIN feedback f ON f.id = r.feedback_id WHERE f.review_id = $rid
       )`,
    )
    .get({ $rid: reviewId }) as { n: number | null };
  const seq = (row.n ?? 0) + 1;
  const ts = nowIso();
  db.query(
    `INSERT INTO patches (review_id, seq, label, summary, body, created_at)
     VALUES ($rid, $seq, $label, $summary, $body, $ts)`,
  ).run({ $rid: reviewId, $seq: seq, $label: label, $summary: summary, $body: body, $ts: ts });
  touchReview(reviewId);
  return { seq, label, summary, created_at: ts };
}

export function listPatchMetas(reviewId: string): PatchMeta[] {
  return db
    .query(
      "SELECT seq, label, summary, created_at FROM patches WHERE review_id = $rid ORDER BY seq ASC",
    )
    .all({ $rid: reviewId }) as PatchMeta[];
}

export function listPatches(reviewId: string): {
  seq: number;
  label: string | null;
  summary: string | null;
  body: string;
  created_at: string;
}[] {
  const rows = db
    .query("SELECT * FROM patches WHERE review_id = $rid ORDER BY seq ASC")
    .all({ $rid: reviewId }) as PatchRow[];
  return rows.map(({ review_id: _, ...p }) => p);
}

export function getPatch(
  reviewId: string,
  seq: number,
): { body: string; label: string | null } | null {
  return db
    .query("SELECT body, label FROM patches WHERE review_id = $rid AND seq = $seq")
    .get({ $rid: reviewId, $seq: seq }) as { body: string; label: string | null } | null;
}

export function deletePatch(reviewId: string, seq: number): boolean {
  const r = db
    .query("DELETE FROM patches WHERE review_id = $rid AND seq = $seq")
    .run({ $rid: reviewId, $seq: seq });
  if (r.changes > 0) touchReview(reviewId);
  return r.changes > 0;
}

export function hasPatches(reviewId: string): boolean {
  return !!db.query("SELECT 1 FROM patches WHERE review_id = $rid LIMIT 1").get({ $rid: reviewId });
}

// ---- snapshots (files-review content captures) ----

export interface SnapshotFileInput {
  path: string; // review-relative path
  content: string; // full file text at capture time ("" for a skipped marker)
  sha: string; // content sha1 (not a git blob sha) — cheap "unchanged?" + future dedup
  // Present-but-non-diffable marker (binary/oversize). A skipped row
  // records that the file existed at capture time without storing its bytes, so
  // the derived diff shows a binary placeholder instead of a phantom deletion.
  skipped?: boolean;
}

// Capture a snapshot: one row in `snapshots` + one `snapshot_files` row per file,
// in a single transaction. seq is monotonic per review (MAX+1). Snapshots are
// append-only + immutable, and feedback is never scoped to a snapshot (quote-first
// display), so seq needn't dodge feedback/reply columns like `addPatch`.
export function addSnapshot(
  reviewId: string,
  files: SnapshotFileInput[],
  label: string | null,
): SnapshotMeta {
  const row = db
    .query("SELECT MAX(seq) AS n FROM snapshots WHERE review_id = $rid")
    .get({ $rid: reviewId }) as { n: number | null };
  const seq = (row.n ?? 0) + 1;
  const ts = nowIso();
  const insSnap = db.query(
    "INSERT INTO snapshots (review_id, seq, label, created_at) VALUES ($rid, $seq, $label, $ts)",
  );
  const insFile = db.query(
    `INSERT INTO snapshot_files (review_id, seq, path, content, sha, skipped)
     VALUES ($rid, $seq, $path, $content, $sha, $skipped)`,
  );
  db.transaction(() => {
    insSnap.run({ $rid: reviewId, $seq: seq, $label: label, $ts: ts });
    for (const f of files)
      insFile.run({
        $rid: reviewId,
        $seq: seq,
        $path: f.path,
        $content: f.content,
        $sha: f.sha,
        $skipped: f.skipped ? 1 : null,
      });
  })();
  touchReview(reviewId);
  return { seq, label, created_at: ts, files: files.map((f) => f.path) };
}

export function listSnapshotMetas(reviewId: string): SnapshotMeta[] {
  const snaps = db
    .query("SELECT seq, label, created_at FROM snapshots WHERE review_id = $rid ORDER BY seq ASC")
    .all({ $rid: reviewId }) as { seq: number; label: string | null; created_at: string }[];
  return snaps.map((s) => ({ ...s, files: snapshotFilePaths(reviewId, s.seq) }));
}

export function snapshotFilePaths(reviewId: string, seq: number): string[] {
  const rows = db
    .query(
      "SELECT path FROM snapshot_files WHERE review_id = $rid AND seq = $seq ORDER BY path ASC",
    )
    .all({ $rid: reviewId, $seq: seq }) as { path: string }[];
  return rows.map((r) => r.path);
}

export function getSnapshotFile(
  reviewId: string,
  seq: number,
  path: string,
): { content: string; sha: string; skipped: boolean } | null {
  const row = db
    .query(
      "SELECT content, sha, skipped FROM snapshot_files WHERE review_id = $rid AND seq = $seq AND path = $path",
    )
    .get({ $rid: reviewId, $seq: seq, $path: path }) as {
    content: string;
    sha: string;
    skipped: number | null;
  } | null;
  // `skipped` is a present-but-non-diffable marker; NULL/0 = a normal
  // stored file.
  return row ? { content: row.content, sha: row.sha, skipped: !!row.skipped } : null;
}

export function hasSnapshot(reviewId: string, seq: number): boolean {
  return !!db
    .query("SELECT 1 FROM snapshots WHERE review_id = $rid AND seq = $seq")
    .get({ $rid: reviewId, $seq: seq });
}

// Remove a snapshot whole (its files cascade). Feedback isn't scoped to snapshots,
// so nothing orphans — a removed snapshot simply drops out of the from/to pickers.
export function deleteSnapshot(reviewId: string, seq: number): boolean {
  const r = db
    .query("DELETE FROM snapshots WHERE review_id = $rid AND seq = $seq")
    .run({ $rid: reviewId, $seq: seq });
  if (r.changes > 0) touchReview(reviewId);
  return r.changes > 0;
}
