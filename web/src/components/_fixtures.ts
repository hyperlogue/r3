// Shared mock data for the component stories. Built from the shared domain
// types (shared/types.ts) so the fixtures stay honest as the contract evolves.
// This is intentionally NOT a *.stories.* file, so Storybook ignores it.

import type { PendingAnchor } from "../selection.ts";
import type {
  DiffLine,
  DiffResult,
  FeedbackWithReplies,
  PatchDiff,
  RenderedFile,
  Reply,
  RepoRecord,
  Review,
  ReviewDetail,
  ThemeOption,
  WatchersResponse,
} from "../types.ts";
import { SUMMARY_FILE } from "../types.ts";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ---- diff (DiffView) ----

const dl = (
  type: DiffLine["type"],
  oldLine: number | null,
  newLine: number | null,
  text: string,
): DiffLine => ({ type, oldLine, newLine, text, html: esc(text) });

export const diffFixture: DiffResult = {
  base: "main",
  head: "feature/wal",
  files: [
    {
      oldPath: "server/db.ts",
      newPath: "server/db.ts",
      path: "server/db.ts",
      status: "modified",
      binary: false,
      additions: 2,
      deletions: 1,
      lines: [
        dl("hunk", null, null, "@@ -10,5 +10,6 @@ export function open(path: string) {"),
        dl("context", 10, 10, "  const db = new Database(path);"),
        dl("del", 11, null, '  db.exec("PRAGMA journal_mode = WAL");'),
        dl("add", null, 11, '  db.exec("PRAGMA journal_mode = WAL;");'),
        dl("add", null, 12, '  db.exec("PRAGMA foreign_keys = ON;");'),
        dl("context", 12, 13, "  return db;"),
        dl("context", 13, 14, "}"),
      ],
    },
    {
      oldPath: null,
      newPath: "server/ids.ts",
      path: "server/ids.ts",
      status: "added",
      binary: false,
      additions: 3,
      deletions: 0,
      lines: [
        dl("hunk", null, null, "@@ -0,0 +1,3 @@"),
        dl("add", null, 1, "export const newId = (prefix: string) =>"),
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source text shown in the diff
        dl("add", null, 2, "  `${prefix}_${crypto.randomUUID().slice(0, 8)}`;"),
        dl("add", null, 3, ""),
      ],
    },
    {
      oldPath: null,
      newPath: "web/public/logo.png",
      path: "web/public/logo.png",
      status: "added",
      binary: true,
      additions: 0,
      deletions: 0,
      lines: [],
    },
  ],
};

export const emptyDiffFixture: DiffResult = { base: "main", head: "main", files: [] };

// ---- stored diff rounds (DiffView) ----

const FIX_ISO = "2026-06-30T12:00:00.000Z";

// The common case: one stored round (no round headers shown).
export const singleRound: PatchDiff[] = [
  {
    seq: 1,
    label: "main..feature/wal",
    summary: null,
    created_at: FIX_ISO,
    files: diffFixture.files,
  },
];

// A follow-up round addressing feedback — same file touched again with line
// numbers that owe nothing to round 1 (rounds are independent).
export const multiRound: PatchDiff[] = [
  ...singleRound,
  {
    seq: 2,
    label: "round 2: guard busy_timeout",
    summary:
      "Addresses the two open items: wraps the pragma block so foreign keys are " +
      "enabled in the same statement, and adds a busy_timeout so concurrent CLI " +
      "writers retry instead of erroring with SQLITE_BUSY.",
    created_at: "2026-06-30T15:00:00.000Z",
    files: [
      {
        oldPath: "server/db.ts",
        newPath: "server/db.ts",
        path: "server/db.ts",
        status: "modified",
        binary: false,
        additions: 1,
        deletions: 0,
        lines: [
          dl("hunk", null, null, "@@ -12,3 +12,4 @@ export function open(path: string) {"),
          dl("context", 12, 12, '  db.exec("PRAGMA foreign_keys = ON;");'),
          dl("add", null, 13, '  db.exec("PRAGMA busy_timeout = 5000;");'),
          dl("context", 13, 14, "  return db;"),
        ],
      },
    ],
  },
];

// A round with a line far wider than the panel — exercises the single
// horizontal scrollbar per file (one scrollbar for the whole diff, not one per
// line). Short rows and their add/del backgrounds still span the full scroll
// width.
export const wideRound: PatchDiff[] = [
  {
    seq: 1,
    label: "wide lines",
    summary: null,
    created_at: FIX_ISO,
    files: [
      {
        oldPath: "server/config.ts",
        newPath: "server/config.ts",
        path: "server/config.ts",
        status: "modified",
        binary: false,
        additions: 1,
        deletions: 1,
        lines: [
          dl("hunk", null, null, "@@ -1,4 +1,4 @@"),
          dl("context", 1, 1, "export function allowedHosts(): string[] {"),
          dl(
            "del",
            2,
            null,
            "  return (process.env.R3_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim());",
          ),
          dl(
            "add",
            null,
            2,
            "  return (process.env.R3_ALLOWED_HOSTS ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0 && s !== '*' && !s.startsWith('-'));",
          ),
          dl("context", 3, 3, "}"),
        ],
      },
    ],
  },
];

// ---- rendered files (FileView) ----

export const renderedCode: RenderedFile = {
  path: "server/ids.ts",
  ref: "WORKING",
  kind: "code",
  lang: "typescript",
  sha: "a1b2c3d",
  markdownHtml: null,
  lines: [
    "// Stable short ids for the domain records.",
    "export function newId(prefix: string): string {",
    "  const rand = crypto.randomUUID().slice(0, 8);",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal source text shown in the file view
    "  return `${prefix}_${rand}`;",
    "}",
  ].map((text, i) => ({ lineNo: i + 1, text, html: esc(text) })),
};

const mdSource = [
  "# r3",
  "",
  "Review. Revise. Resolve.",
  "",
  "- Local-first",
  "- Agent-aware",
  "",
  "| Kind | Source | Watched |",
  "| --- | --- | --- |",
  "| files | live view of now | yes |",
  "| diff | immutable rounds | no |",
];
export const renderedMarkdown: RenderedFile = {
  path: "README.md",
  ref: "WORKING",
  kind: "markdown",
  lang: "markdown",
  sha: "f00ba12",
  lines: mdSource.map((text, i) => ({ lineNo: i + 1, text, html: esc(text) })),
  markdownHtml: [
    '<h1 data-line-start="1" data-line-end="1">r3</h1>',
    '<p data-line-start="3" data-line-end="3">Review. Revise. Resolve.</p>',
    '<ul data-line-start="5" data-line-end="6"><li>Local-first</li><li>Agent-aware</li></ul>',
    '<table data-line-start="8" data-line-end="11"><thead><tr><th>Kind</th><th>Source</th><th>Watched</th></tr></thead>' +
      "<tbody><tr><td>files</td><td>live view of now</td><td>yes</td></tr>" +
      "<tr><td>diff</td><td>immutable rounds</td><td>no</td></tr></tbody></table>",
  ].join("\n"),
};

// ---- projects + reviews (Home / ReviewSwitcher) ----

const ISO = "2026-06-30T12:00:00.000Z";

export const repos: (RepoRecord & { present?: boolean })[] = [
  {
    id: "repo_r3",
    commonDir: "/Users/dev/code/r3/.git",
    name: "r3",
    remote: "git@github.com:hovo/r3.git",
    lastSeen: ISO,
    createdAt: ISO,
    present: true,
  },
  {
    // Same basename as repo_r3 ("r3") at a different path — exercises the
    // minimal-unique-suffix labels (code/r3 vs forks/r3).
    id: "repo_fork",
    commonDir: "/Users/dev/forks/r3/.git",
    name: "r3",
    remote: "git@github.com:other/r3.git",
    lastSeen: ISO,
    createdAt: ISO,
    present: true,
  },
  {
    id: "repo_old",
    commonDir: "/Users/dev/code/legacy-viewer/.git",
    name: "legacy-viewer",
    remote: null,
    lastSeen: ISO,
    createdAt: ISO,
    present: false, // clone moved/deleted → relink/forget affordance
  },
];

export const reviews: Review[] = [
  {
    id: "review_remote",
    repo_id: "repo_r3",
    worktree: { name: "", branch: "main", pathHint: "/Users/dev/code/r3" },
    title: "Daemon remote access",
    summary: null,
    kind: "diff",
    source: { base: "main", head: "feature/remote" },
    meta: { session: "claude-remote" },
    status: "open",
    created_by: "agent",
    created_at: ISO,
    updated_at: "2026-06-30T09:00:00.000Z",
  },
  {
    id: "review_files",
    repo_id: "repo_r3",
    worktree: { name: "wt-ui", branch: "feature/multi-project", pathHint: "/Users/dev/code/r3-ui" },
    title: null,
    summary: null,
    kind: "files",
    source: { ref: "WORKING", files: ["web/src/components/Sidebar.tsx", "web/src/api.ts"] },
    meta: {},
    status: "open",
    created_by: "human",
    created_at: ISO,
    updated_at: "2026-06-30T11:00:00.000Z",
  },
  {
    id: "review_done",
    repo_id: "repo_r3",
    worktree: { name: "", branch: "main", pathHint: "/Users/dev/code/r3" },
    title: "WAL + foreign keys",
    summary: null,
    kind: "diff",
    source: { base: "a1b2c3d4e5f6", head: "f6e5d4c3b2a1" },
    meta: { session: "cli" },
    status: "approved",
    created_by: "cli",
    created_at: ISO,
    updated_at: "2026-06-30T10:00:00.000Z",
  },
  {
    id: "review_fork",
    repo_id: "repo_fork",
    worktree: { name: "", branch: "spike/perf", pathHint: "/Users/dev/forks/r3" },
    title: "Fork: render perf spike",
    summary: null,
    kind: "diff",
    source: { base: "main", head: "spike/perf" },
    meta: { session: "claude-fork" },
    status: "open",
    created_by: "agent",
    created_at: ISO,
    updated_at: "2026-06-30T08:00:00.000Z",
    // An agent is blocked on `r3 watch` here → ranks to the top of the list
    // despite being the oldest open review.
    watching: true,
  },
  {
    id: "review_legacy",
    repo_id: "repo_old",
    worktree: null,
    title: "Old import path migration",
    summary: null,
    kind: "files",
    source: { ref: "HEAD", files: ["src/index.js"] },
    meta: {},
    status: "abandoned",
    created_by: "human",
    created_at: ISO,
    updated_at: "2026-06-30T07:00:00.000Z",
  },
];

// ---- review detail + feedback (FeedbackPanel) ----

// A later timestamp than ISO, for feedback/replies already delivered to the
// agent. Feedback/replies default to unsent (sent_at null).
const SENT_ISO = "2026-06-30T16:00:00.000Z";

const fb = (
  over: Partial<FeedbackWithReplies> & Pick<FeedbackWithReplies, "id" | "body">,
): FeedbackWithReplies => ({
  review_id: "review_remote",
  author: "human",
  file: "server/db.ts",
  side: "new",
  line_start: 11,
  line_end: 12,
  quote: null,
  code_sha: "deadbeef",
  anchor: "anchored",
  status: "open",
  patch_seq: null,
  created_at: ISO,
  updated_at: ISO,
  sent_at: null,
  status_unsent: false,
  replies: [],
  ...over,
});

const rp = (over: Partial<Reply> & Pick<Reply, "id" | "feedback_id" | "body">): Reply => ({
  author: "agent",
  patch_seq: null,
  file: null,
  line_start: null,
  line_end: null,
  quote: null,
  created_at: ISO,
  sent_at: null,
  ref_version: null,
  ...over,
});

export const reviewDetail: ReviewDetail = {
  ...reviews[0],
  summary:
    "Reworks the SQLite bootstrap: enable WAL + foreign keys in one pragma block " +
    "and guard busy_timeout so concurrent CLI writers don't hit SQLITE_BUSY. Round " +
    "2 addresses the index-name collision the human flagged.",
  stale: false,
  repoName: "r3",
  branch: "main",
  scratchDir: null,
  scratchIgnoredDirs: [],
  patches: [
    { seq: 1, label: "main..feature/wal", summary: null, created_at: ISO },
    {
      seq: 2,
      label: "round 2: guard busy_timeout",
      summary:
        "Enable foreign keys in the pragma block and add a busy_timeout for concurrent writers.",
      created_at: ISO,
    },
  ],
  snapshots: [],
  feedback: [
    fb({
      id: "feedback_pragma",
      body:
        "Add a trailing semicolon and enable `foreign_keys` in the **same** pragma block:\n\n" +
        "- keeps the two PRAGMAs atomic\n" +
        "- avoids a second `db.exec` round-trip\n\n" +
        "See @server/db.ts:L11-12 for where it lands.",
      quote: 'db.exec("PRAGMA journal_mode = WAL");',
      line_start: 11,
      line_end: 11,
    }),
    fb({
      id: "feedback_outdated",
      body: "This index name collides with the one created in migrations.ts.",
      file: "server/db.ts",
      line_start: 42,
      line_end: 44,
      anchor: "outdated",
      replies: [
        rp({
          id: "reply_1",
          feedback_id: "feedback_outdated",
          body: "Good catch — renamed it to idx_feedback_review.",
          // Anchored reply: the fix landed in round 2.
          patch_seq: 2,
          file: "server/db.ts",
          line_start: 13,
          line_end: 13,
        }),
      ],
    }),
    // Already delivered to the agent (sent_at set → no Edit in its ⋯ menu),
    // with a long thread whose earlier turns are sent and one unsent human
    // follow-up — the state a follow-up prompt renders as a compact block.
    // Also exercises the folded thread (last two shown).
    fb({
      id: "feedback_thread",
      body: "The WAL pragma should run before any writes so the very first transaction is journaled correctly — move it to the top of open().",
      file: "server/db.ts",
      line_start: 10,
      line_end: 10,
      quote: "  const db = new Database(path);",
      sent_at: SENT_ISO,
      replies: [
        rp({
          id: "reply_a1",
          feedback_id: "feedback_thread",
          sent_at: SENT_ISO,
          body:
            "Agreed, and it's a real ordering hazard rather than a style nit. SQLite decides " +
            "the journal mode lazily on the first write that needs a rollback journal, so if a " +
            "migration or seed runs before `PRAGMA journal_mode = WAL` we can silently end up in " +
            "the default rollback-journal mode for that connection.\n\n" +
            "I moved the pragma block to run immediately after `new Database(path)` and before " +
            "we hand the handle to the migrator. I also verified with `PRAGMA journal_mode;` on a " +
            "fresh db that it reports `wal` for the first transaction now, where before it " +
            "reported `delete` until the connection was recycled.",
        }),
        rp({
          id: "reply_a2",
          feedback_id: "feedback_thread",
          author: "human",
          sent_at: SENT_ISO,
          body: "Great — can you also confirm the busy_timeout is set on that same early path?",
        }),
        rp({
          id: "reply_a3",
          feedback_id: "feedback_thread",
          sent_at: SENT_ISO,
          body:
            "Yes. The busy_timeout is set in the same pragma block, right after journal_mode, so " +
            "both apply before the first statement. Landed in round 2 — see " +
            '@server/db.ts:L13.\n\n```ts\ndb.exec("PRAGMA busy_timeout = 5000;");\n```',
          patch_seq: 2,
          file: "server/db.ts",
          line_start: 13,
          line_end: 13,
          // Inline @refs in this reply resolve against round 2 (captured at post time).
          ref_version: 2,
        }),
        // The one unsent turn: a human follow-up posted after the last hand-off.
        rp({
          id: "reply_a4",
          feedback_id: "feedback_thread",
          author: "human",
          body: "Perfect. One more — does the same ordering hold for the :memory: test db?",
        }),
      ],
    }),
    // Resolved after the agent pushed back — the disagreement lives in the
    // thread, not a status (the old refuted verdict folded into resolved). Its
    // bare resolution hasn't been delivered yet (status_unsent), the state a
    // follow-up prompt reports as "[resolved] — no action needed".
    fb({
      id: "feedback_pushback",
      body: "Do we need foreign_keys ON here? It adds overhead on every write.",
      file: "server/db.ts",
      line_start: 12,
      line_end: 12,
      quote: '  db.exec("PRAGMA foreign_keys = ON;");',
      status: "resolved",
      sent_at: SENT_ISO,
      status_unsent: true,
      replies: [
        rp({
          id: "reply_r1",
          feedback_id: "feedback_pushback",
          sent_at: SENT_ISO,
          body:
            "Keeping it on. The overhead is a per-statement check that's negligible for our write " +
            "volume, and it's the only thing stopping an orphaned reply from outliving its " +
            "feedback when a cascade delete races a concurrent insert.",
        }),
      ],
    }),
    fb({
      id: "feedback_general",
      body: "Overall the daemon refactor reads well. Consider a short README section on the token flow.",
      file: "",
      side: null,
      line_start: null,
      line_end: null,
      quote: null,
    }),
    // Agent-authored (r3 feedback add): the agent guiding the human — wears the
    // "agent" chip and, with no replies yet, floats into the attention zone
    // ("your turn"). Born delivered (sent_at set), so it never re-enters the
    // agent's own prompts; the human's reply/resolution flows back instead.
    fb({
      id: "feedback_agent_note",
      author: "agent",
      body: "Start with `server/db.ts` — the WAL ordering is the risky part; the rest of the diff is mechanical renames.",
      file: "server/db.ts",
      line_start: 10,
      line_end: 12,
      quote: '  const db = new Database(path);\n  db.exec("PRAGMA journal_mode = WAL;");',
      sent_at: SENT_ISO,
    }),
    // Anchored to a whole file (the file header's feedback button): a real path
    // with no line span or quote — renders as the path alone (no ":Lx"), and the
    // agent prompt shows "server/db.ts (whole file)".
    fb({
      id: "feedback_whole_file",
      body: "This module is doing too much — consider splitting the pragma setup out of open().",
      file: "server/db.ts",
      side: null,
      line_start: null,
      line_end: null,
      quote: null,
    }),
    // Anchored to a range of the review's own summary (the SUMMARY_FILE sentinel,
    // patch_seq null) — renders as "review summary" in the panel/prompt.
    fb({
      id: "feedback_review_summary",
      body: "Say 'DNS-rebinding' here to match the security section's wording.",
      file: SUMMARY_FILE,
      side: null,
      line_start: 1,
      line_end: 1,
      quote: "Adds the host allowlist + token checks",
    }),
    // Anchored to round 2's summary (SUMMARY_FILE + patch_seq 2) — "diff 2 summary".
    fb({
      id: "feedback_round_summary",
      body: "Mention the default busy_timeout value (5s) in this round summary.",
      file: SUMMARY_FILE,
      side: null,
      line_start: 1,
      line_end: 1,
      quote: "adds a busy_timeout for concurrent writers",
      patch_seq: 2,
    }),
    fb({
      id: "feedback_resolved",
      body: "Typo in the log message: 'sucessfully'.",
      file: "server/index.ts",
      line_start: 88,
      line_end: 88,
      status: "resolved",
      replies: [
        rp({
          id: "reply_2",
          feedback_id: "feedback_resolved",
          author: "human",
          body: "Fixed.",
        }),
      ],
    }),
  ],
};

// Everything delivered: every feedback + reply marked sent, so no candidate has
// unsent content and the panel's "Copy prompt" / "Submit" is disabled with
// the "everything has been sent" title. A fresh reply/feedback re-enables it.
export const allSentDetail: ReviewDetail = {
  ...reviewDetail,
  feedback: reviewDetail.feedback.map((f) => ({
    ...f,
    sent_at: SENT_ISO,
    status_unsent: false,
    replies: f.replies.map((r) => ({ ...r, sent_at: SENT_ISO })),
  })),
};

export const pendingAnchor: PendingAnchor = {
  file: "server/db.ts",
  side: "new",
  lineStart: 11,
  lineEnd: 12,
  quote: '  db.exec("PRAGMA journal_mode = WAL;");\n  db.exec("PRAGMA foreign_keys = ON;");',
};

// A whole-file composer target (the file header's feedback button): a real path
// with no span or quote, so the composer shows just the path and no quote block.
export const wholeFilePendingAnchor: PendingAnchor = {
  file: "server/db.ts",
  side: null,
  lineStart: null,
  lineEnd: null,
  quote: null,
};

export const noWatchers: WatchersResponse = { watchers: [] };
export const watching: WatchersResponse = {
  watchers: [{ session: "claude-remote", agentId: "agent_7f3a" }],
};

// ---- themes (SettingsPopup) ----

export const themeOptions: ThemeOption[] = [
  { id: "github", label: "GitHub", group: "Auto (light + dark)" },
  { id: "vitesse", label: "Vitesse", group: "Auto (light + dark)" },
  { id: "one", label: "One", group: "Auto (light + dark)" },
  { id: "github-dark", label: "GitHub Dark", group: "Dark" },
  { id: "github-light", label: "GitHub Light", group: "Light" },
];
