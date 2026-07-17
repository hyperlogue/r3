// Build-time generator for the demo's seed fixtures. It runs under Bun (so it has
// the real Shiki/markdown-it pipeline) and BAKES every rendered payload — diff
// rounds, file blobs, snapshot diffs — into web/demo/fixtures.gen.ts as plain
// data. The demo then serves that verbatim, so no highlighter ever ships to the
// browser. Re-run with `bun run gen:demo` after editing the canned content below.
//
// The demo reviews r3's OWN code — it dogfoods the tool on the very repo it ships
// from. Content is authored here as before/after file text; the diffs and anchors
// are derived programmatically so quotes always match (findQuote can relocate them).

import { join } from "node:path";
import { blobSha } from "../server/git.ts";
import {
  escapeHtml,
  highlightToLines,
  langForPath,
  listThemes,
  themeStyle,
} from "../server/highlight.ts";
import { renderContent } from "../server/render.ts";
import { diffFile } from "../server/textdiff.ts";
import type {
  DiffFileChange,
  Feedback,
  Reply,
  RepoRecord,
  Review,
  ThemeStyle,
} from "../shared/types.ts";
import type {
  DemoSeed,
  StoredBlob,
  StoredPatch,
  StoredSnapshot,
  StoredSnapshotDiff,
} from "../web/demo/model.ts";

// ---- helpers ----

const REPO_ID = "repo_demo";
// Fixed timestamps keep the generated file deterministic (Date.now would churn it).
const T0 = "2026-07-14T09:00:00.000Z";
const T1 = "2026-07-14T10:30:00.000Z";
const T2 = "2026-07-14T11:15:00.000Z";
const T3 = "2026-07-15T08:20:00.000Z";

// Real lines of a file (drop the phantom trailing "" on newline-terminated text).
function linesOf(content: string): string[] {
  const all = content.split("\n");
  if (content.endsWith("\n")) all.pop();
  return all;
}

const MAX_QUOTE_LINES = 4;
function quoteFrom(content: string, start: number, end: number): string {
  const slice = linesOf(content).slice(start - 1, end);
  return slice.length > MAX_QUOTE_LINES
    ? slice.slice(0, MAX_QUOTE_LINES).join("\n")
    : slice.join("\n");
}

// Render a before/after pair into a highlighted DiffFileChange (Shiki inner HTML
// mapped back onto each row, preferring the new side — same as the daemon).
async function renderDiff(path: string, oldC: string, newC: string): Promise<DiffFileChange> {
  const dfc = diffFile(path, oldC, newC);
  if (!dfc) throw new Error(`no diff for ${path} (identical content?)`);
  const lang = langForPath(path);
  const oldHtml = oldC ? await highlightToLines(oldC, lang, await blobSha(oldC)) : [];
  const newHtml = newC ? await highlightToLines(newC, lang, await blobSha(newC)) : [];
  for (const ln of dfc.lines) {
    if (ln.type === "hunk") continue;
    if (ln.newLine != null) ln.html = newHtml[ln.newLine - 1] ?? escapeHtml(ln.text);
    else if (ln.oldLine != null) ln.html = oldHtml[ln.oldLine - 1] ?? escapeHtml(ln.text);
    else ln.html = escapeHtml(ln.text);
  }
  return dfc;
}

const feedback: Feedback[] = [];
const replies: Reply[] = [];

function fb(f: Partial<Feedback> & Pick<Feedback, "id" | "review_id" | "body">): Feedback {
  const row: Feedback = {
    author: "human",
    file: "",
    side: null,
    line_start: null,
    line_end: null,
    quote: null,
    code_sha: null,
    anchor: "anchored",
    status: "open",
    patch_seq: null,
    created_at: T1,
    updated_at: T1,
    sent_at: null,
    status_unsent: false,
    ...f,
  };
  feedback.push(row);
  return row;
}

function reply(r: Partial<Reply> & Pick<Reply, "id" | "feedback_id" | "author" | "body">): void {
  replies.push({
    patch_seq: null,
    file: null,
    line_start: null,
    line_end: null,
    quote: null,
    created_at: T2,
    sent_at: T2,
    ref_version: null,
    ...r,
  });
}

// ---- canned content: r3 reviewing itself ----

// Review A — a diff review of server/git.ts: add the argument-injection guard
// that keeps a ref like `--output=<file>` from reaching git as an option.

// Baseline ("main"): readContentAt shells out to `git show` with no ref guard.
const gitOld = `const isSentinel = (r: GitRef): r is "WORKING" | "STAGED" => r === "WORKING" || r === "STAGED";

// Read a file's content at a given ref, within a repo's worktree. WORKING reads
// disk, STAGED the index, anything else is \`git show <ref>:<path>\`.
export async function readContentAt(repo: Repo, path: string, ref: GitRef): Promise<string | null> {
  if (isSentinel(ref)) return readSentinel(repo, path, ref);
  const { stdout, code } = await repo.git(["show", \`\${ref}:\${path}\`]);
  return code === 0 ? stdout : null;
}
`;

// Round 1: introduce isSafeRef and gate readContentAt on it.
const gitRound1 = `const isSentinel = (r: GitRef): r is "WORKING" | "STAGED" => r === "WORKING" || r === "STAGED";

// A ref beginning with "-" is parsed by git as an option, not a tree-ish —
// argument injection (e.g. \`--output=<file>\` makes git show write a file).
// Sentinels and real refs never start with "-", so reject anything that does.
export function isSafeRef(ref: GitRef): boolean {
  return isSentinel(ref) || !ref.startsWith("-");
}

// Read a file's content at a given ref, within a repo's worktree. WORKING reads
// disk, STAGED the index, anything else is \`git show <ref>:<path>\`.
export async function readContentAt(repo: Repo, path: string, ref: GitRef): Promise<string | null> {
  if (!isSafeRef(ref)) return null;
  if (isSentinel(ref)) return readSentinel(repo, path, ref);
  const { stdout, code } = await repo.git(["show", \`\${ref}:\${path}\`]);
  return code === 0 ? stdout : null;
}
`;

// Round 2 (the agent appends this on the first hand-off): also reject empty /
// whitespace-only refs — exactly what feedback_gitref1 asks for.
const gitRound2 = `const isSentinel = (r: GitRef): r is "WORKING" | "STAGED" => r === "WORKING" || r === "STAGED";

// A ref beginning with "-" is parsed by git as an option, not a tree-ish —
// argument injection (e.g. \`--output=<file>\` makes git show write a file). An
// empty or whitespace-only ref is meaningless and must not reach git either.
export function isSafeRef(ref: GitRef): boolean {
  if (isSentinel(ref)) return true;
  return ref.trim().length > 0 && !ref.startsWith("-");
}

// Read a file's content at a given ref, within a repo's worktree. WORKING reads
// disk, STAGED the index, anything else is \`git show <ref>:<path>\`.
export async function readContentAt(repo: Repo, path: string, ref: GitRef): Promise<string | null> {
  if (!isSafeRef(ref)) return null;
  if (isSentinel(ref)) return readSentinel(repo, path, ref);
  const { stdout, code } = await repo.git(["show", \`\${ref}:\${path}\`]);
  return code === 0 ? stdout : null;
}
`;

// Review B — a files review of server/paths.ts + the README security note: add a
// symlink-escape guard so an in-repo symlink can't read outside the review root.

const pathsBefore = `import { isAbsolute, resolve, sep } from "node:path";

// Resolve a repo-relative path against \`root\`, refusing anything that escapes it.
// Returns the absolute path, or null if the input is unsafe (absolute, or \`..\`).
export function safePathIn(root: string, p: string): string | null {
  if (!p || typeof p !== "string") return null;
  if (isAbsolute(p)) return null;
  if (p.split(/[/\\\\]/).includes("..")) return null;
  const abs = resolve(root, p);
  return abs === root || abs.startsWith(root + sep) ? abs : null;
}
`;

const pathsLive = `import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

// Resolve a repo-relative path against \`root\`, refusing anything that escapes it.
// Returns the absolute path, or null if the input is unsafe (absolute, or \`..\`).
export function safePathIn(root: string, p: string): string | null {
  if (!p || typeof p !== "string") return null;
  if (isAbsolute(p)) return null;
  if (p.split(/[/\\\\]/).includes("..")) return null;
  const abs = resolve(root, p);
  return abs === root || abs.startsWith(root + sep) ? abs : null;
}

// Symlink-escape guard for the actual read sites. safePathIn is lexical, so a
// file inside \`root\` that is itself a symlink to \`/etc/passwd\` passes it. At the
// point of use, realpath the candidate and confirm the real target still lies
// within the root. Returns false when it escapes, or can't be resolved.
export function realpathWithin(root: string, abs: string): boolean {
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(abs);
    return real === realRoot || real.startsWith(realRoot + sep);
  } catch {
    return false;
  }
}
`;

const readmeBefore = `## Security

r3 binds \`127.0.0.1\` by default and gates every API request behind a per-user
token. Path inputs are validated against the review's worktree root —
repo-relative, no \`..\`, no absolute paths.

For remote access, prefer \`ssh -L 8791:localhost:8791\` or \`tailscale serve\` over
binding a public interface. Never bind \`0.0.0.0\`.
`;

const readmeLive = `## Security

r3 binds \`127.0.0.1\` by default and gates every API request behind a per-user
token. Path inputs are validated against the review's worktree root —
repo-relative, no \`..\`, no absolute paths. At the point of use we also resolve
symlinks, so an in-repo link to \`/etc/passwd\` can't read files outside the
review root.

For remote access, prefer \`ssh -L 8791:localhost:8791\` or \`tailscale serve\` over
binding a public interface. Never bind \`0.0.0.0\`.
`;

const reviewBSummary =
  "Adds a symlink-escape guard (`realpathWithin`) so an in-repo link can't read files outside the review root. `safePathIn` stays lexical for membership checks; the new guard runs at the point of use. Flag anything that looks off.";

// ---- assemble ----

async function main() {
  const reviews: Review[] = [
    {
      id: "review_gitref",
      repo_id: REPO_ID,
      worktree: { name: "", branch: "harden-git-refs", pathHint: "/demo/r3" },
      title: "Guard git refs against argument injection",
      summary:
        "Adds `isSafeRef` to `server/git.ts` so a ref like `--output=<file>` can't be parsed by git as an option and made to write a file. Round 1 gates `readContentAt`; open to tightening the empty-ref case.",
      kind: "diff",
      source: { base: "main", head: "harden-git-refs" },
      meta: { session: "demo", agent: "claude", branch: "harden-git-refs" },
      status: "open",
      created_by: "agent",
      created_at: T0,
      updated_at: T1,
    },
    {
      id: "review_pathsafe",
      repo_id: REPO_ID,
      worktree: { name: "", branch: "main", pathHint: "/demo/r3" },
      title: "Add a symlink-escape guard to path validation",
      summary: reviewBSummary,
      kind: "files",
      source: { ref: "WORKING", files: ["server/paths.ts", "README.md"] },
      meta: { session: "demo", agent: "claude" },
      status: "open",
      created_by: "human",
      created_at: T0,
      updated_at: T1,
    },
  ];

  // Review A rounds.
  const round1Files = [await renderDiff("server/git.ts", gitOld, gitRound1)];
  const round2Files = [await renderDiff("server/git.ts", gitRound1, gitRound2)];
  const patches: StoredPatch[] = [
    {
      review_id: "review_gitref",
      seq: 1,
      label: "main..harden-git-refs",
      summary: "Round 1 — add `isSafeRef` and gate `readContentAt` on it.",
      created_at: T0,
      files: round1Files,
    },
  ];
  const pendingRounds: StoredPatch[] = [
    {
      review_id: "review_gitref",
      seq: 2,
      label: "round 2: reject empty refs",
      summary: "Also reject empty/whitespace refs, so a blank `?ref=` can't reach `git show`.",
      created_at: T2,
      files: round2Files,
    },
  ];

  // Review A feedback.
  fb({
    id: "feedback_gitref1",
    review_id: "review_gitref",
    author: "human",
    body: 'An empty-string ref sails through `!"".startsWith("-")` — a blank `?ref=` would still reach `git show`. Can we also reject empty/whitespace refs here?',
    file: "server/git.ts",
    side: "new",
    line_start: 7,
    line_end: 7,
    quote: quoteFrom(gitRound1, 7, 7),
    code_sha: await blobSha(quoteFrom(gitRound1, 7, 7)),
    patch_seq: 1,
  });
  fb({
    id: "feedback_gitref2",
    review_id: "review_gitref",
    author: "agent",
    body: "Start reading here — `isSafeRef` is the whole guard, and every `git()` call that takes an untrusted ref routes through it.",
    file: "server/git.ts",
    patch_seq: 1,
    // Agent-authored feedback is born delivered.
    sent_at: T0,
    created_at: T0,
    updated_at: T0,
  });
  fb({
    id: "feedback_gitref3",
    review_id: "review_gitref",
    author: "human",
    body: "Good — the guard runs before we ever build the `git show` argv.",
    file: "server/git.ts",
    side: "new",
    line_start: 13,
    line_end: 13,
    quote: quoteFrom(gitRound1, 13, 13),
    code_sha: await blobSha(quoteFrom(gitRound1, 13, 13)),
    patch_seq: 1,
    status: "resolved",
    sent_at: T1,
  });
  reply({
    id: "reply_gitref3a",
    feedback_id: "feedback_gitref3",
    author: "agent",
    body: "Right — `isSafeRef` gates the function before any git call touches the ref.",
    ref_version: 1,
  });

  // Review B blobs (live content) + snapshot (before) + derived snapshot diff.
  const blobs: StoredBlob[] = [
    {
      review_id: "review_pathsafe",
      ref: "WORKING",
      path: "server/paths.ts",
      rendered: await renderContent("server/paths.ts", pathsLive, "WORKING"),
    },
    {
      review_id: "review_pathsafe",
      ref: "WORKING",
      path: "README.md",
      rendered: await renderContent("README.md", readmeLive, "WORKING"),
    },
  ];
  const snapshots: StoredSnapshot[] = [
    {
      review_id: "review_pathsafe",
      seq: 1,
      label: "before edits",
      created_at: T0,
      files: ["server/paths.ts", "README.md"],
      contents: { "server/paths.ts": pathsBefore, "README.md": readmeBefore },
    },
  ];
  const snapshotDiffs: StoredSnapshotDiff[] = [
    {
      review_id: "review_pathsafe",
      from: 1,
      to: "WORKING",
      files: [
        await renderDiff("server/paths.ts", pathsBefore, pathsLive),
        await renderDiff("README.md", readmeBefore, readmeLive),
      ],
    },
  ];

  // Review B feedback.
  fb({
    id: "feedback_ps1",
    review_id: "review_pathsafe",
    author: "human",
    body: "Does `realpathSync` throw for a path that doesn't exist yet? Membership edits validate paths before the file is created — is that what the try/catch is covering?",
    file: "server/paths.ts",
    line_start: 21,
    line_end: 21,
    quote: quoteFrom(pathsLive, 21, 21),
    code_sha: await blobSha(quoteFrom(pathsLive, 21, 21)),
  });
  fb({
    id: "feedback_ps2",
    review_id: "review_pathsafe",
    author: "human",
    body: "Worth a test: a symlink placed inside the root that points at `/etc/passwd` must come back rejected.",
    file: "server/paths.ts",
    // whole-file note: real path, no span.
  });
  fb({
    id: "feedback_ps3",
    review_id: "review_pathsafe",
    author: "human",
    body: "Can you confirm the lexical `safePathIn` still handles not-yet-existing paths for membership edits, before this guard runs?",
    file: "@summary",
    line_start: 1,
    line_end: 1,
    quote: "an in-repo link can't read files outside the review root",
    code_sha: await blobSha("an in-repo link can't read files outside the review root"),
  });

  const repo: RepoRecord = {
    id: REPO_ID,
    commonDir: "/demo/r3/.git",
    name: "r3",
    remote: "https://github.com/hyperlogue/r3",
    lastSeen: T3,
    createdAt: T0,
    present: true,
  };

  // Bake theme metadata + per-theme surface colours so the settings theme picker
  // is fully functional offline.
  const themes = listThemes();
  const themeStyles: Record<string, ThemeStyle> = {};
  await Promise.all(
    themes.map(async (t) => {
      themeStyles[t.id] = await themeStyle(t.id);
    }),
  );

  const seed: DemoSeed = {
    repo,
    reviews,
    feedback,
    replies,
    patches,
    snapshots,
    blobs,
    snapshotDiffs,
    fileContents: {
      review_pathsafe: { "server/paths.ts": pathsLive, "README.md": readmeLive },
    },
    pendingRounds,
    themes,
    themeStyles,
  };

  const out = join(import.meta.dir, "..", "web/demo/fixtures.gen.ts");
  const header =
    "// GENERATED by scripts/gen-demo-fixtures.ts — do not edit by hand.\n" +
    "// Rendered payloads (Shiki HTML) are baked in so the demo needs no highlighter.\n" +
    'import type { DemoSeed } from "./model.ts";\n\n' +
    "export const SEED = ";
  await Bun.write(out, `${header}${JSON.stringify(seed)} as unknown as DemoSeed;\n`);
  const blobCount = blobs.length;
  console.log(
    `✓ wrote web/demo/fixtures.gen.ts — ${reviews.length} reviews, ${feedback.length} feedback, ${patches.length} rounds, ${blobCount} blobs, ${themes.length} themes`,
  );
}

await main();
